import MatrixEvent from '../models/event';
import {logger} from '../logger';
import { createNewMatrixCall, MatrixCall, CallErrorCode } from './call';

export class CallEventHandler {
    client: any;
    calls: Map<string, MatrixCall>;
    callEventBuffer: Array<MatrixEvent>;
    candidatesByCall: Map<string, Array<RTCIceCandidate>>;

    constructor(client: any) {
        this.client = client;
        this.calls = new Map<string, MatrixCall>();
        // The sync code always emits one event at a time, so it will patiently
        // wait for us to finish processing a call invite before delivering the
        // next event, even if that next event is a hangup. We therefore accumulate
        // all our call events and then process them on the 'sync' event, ie.
        // each time a sync has completed. This way, we can avoid emitting incoming
        // call events if we get both the invite and answer/hangup in the same sync.
        // This happens quite often, eg. replaying sync from storage, catchup sync
        // after loading and after we've been offline for a bit.
        this.callEventBuffer = [];
        this.candidatesByCall = new Map<string, Array<RTCIceCandidate>>();
        this.client.on("sync", this.evaluateEventBuffer);
        this.client.on("event", this.onEvent);
    }

    stop() {
        this.client.removeEventListener("sync", this.evaluateEventBuffer);
        this.client.removeEventListener("event", this.onEvent);
    }

    private evaluateEventBuffer = () => {
        if (this.client.getSyncState() === "SYNCING") {
            // don't process any events until they are all decrypted
            if (this.callEventBuffer.some((e) => e.isBeingDecrypted())) return;

            const ignoreCallIds = new Set<String>();
            // inspect the buffer and mark all calls which have been answered
            // or hung up before passing them to the call event handler.
            for (const ev of this.callEventBuffer) {
                if (ev.getType() === "m.call.answer" ||
                        ev.getType() === "m.call.hangup") {
                    ignoreCallIds.add(ev.getContent().call_id);
                }
            }
            // now loop through the buffer chronologically and inject them
            for (const e of this.callEventBuffer) {
                if (
                    e.getType() === "m.call.invite" &&
                    ignoreCallIds.has(e.getContent().call_id)
                ) {
                    // This call has previously been answered or hung up: ignore it
                    continue;
                }
                try {
                    this.handleCallEvent(e);
                } catch (e) {
                    logger.error("Caught exception handling call event", e);
                }
            }
            this.callEventBuffer = [];
        }
    }

    private onEvent = (event: MatrixEvent) => {
        // any call events or ones that might be once they're decrypted
        if (event.getType().indexOf("m.call.") === 0 || event.isBeingDecrypted()) {
            // queue up for processing once all events from this sync have been
            // processed (see above).
            this.callEventBuffer.push(event);
        }

        if (event.isBeingDecrypted() || event.isDecryptionFailure()) {
            // add an event listener for once the event is decrypted.
            event.once("Event.decrypted", () => {
                if (event.getType().indexOf("m.call.") === -1) return;

                if (this.callEventBuffer.includes(event)) {
                    // we were waiting for that event to decrypt, so recheck the buffer
                    this.evaluateEventBuffer();
                } else {
                    // This one wasn't buffered so just run the event handler for it
                    // straight away
                    try {
                        this.handleCallEvent(event);
                    } catch (e) {
                        logger.error("Caught exception handling call event", e);
                    }
                }
            });
        }
    }

    private handleCallEvent(event: MatrixEvent) {
        const content = event.getContent();
        let call = content.call_id ? this.calls.get(content.call_id) : undefined;
        //console.info("RECV %s content=%s", event.getType(), JSON.stringify(content));

        if (event.getType() === "m.call.invite") {
            if (event.getSender() === this.client.credentials.userId) {
                return; // ignore invites you send
            }

            // XXX: age is always wrong for events from a stored sync so this doesn't
            // really work. getLocalAge works by comparing the event's timestamp to the
            // local system clock so is probably worse (ie. if your clock was over a minute
            // fast, you wouldn't be able to receive any calls at all).
            if (event.getAge() > content.lifetime) {
                return; // expired call
            }

            if (call && call.state === "ended") {
                return; // stale/old invite event
            }
            if (call) {
                logger.log(
                    "WARN: Already have a MatrixCall with id %s but got an " +
                    "invite. Clobbering.",
                    content.call_id,
                );
            }

            call = createNewMatrixCall(this.client, event.getRoomId(), {
                forceTURN: this.client._forceTURN,
            });
            if (!call) {
                logger.log(
                    "Incoming call ID " + content.call_id + " but this client " +
                    "doesn't support WebRTC",
                );
                // don't hang up the call: there could be other clients
                // connected that do support WebRTC and declining the
                // the call on their behalf would be really annoying.
                return;
            }

            call.callId = content.call_id;
            call.initWithInvite(event);
            this.calls.set(call.callId, call);

            // if we stashed candidate events for that call ID, play them back now
            if (this.candidatesByCall.get(call.callId)) {
                for (const cand of this.candidatesByCall.get(call.callId)) {
                    call.gotRemoteIceCandidate(cand);
                }
            }

            // Were we trying to call that user (room)?
            let existingCall;
            for (const thisCall of this.calls.values()) {
                if (call.roomId === thisCall.roomId &&
                        thisCall.direction === 'outbound' &&
                        (["wait_local_media", "create_offer", "invite_sent"].indexOf(
                            thisCall.state) !== -1)) {
                    existingCall = thisCall;
                    break;
                }
            }

            if (existingCall) {
                // If we've only got to wait_local_media or create_offer and
                // we've got an invite, pick the incoming call because we know
                // we haven't sent our invite yet otherwise, pick whichever
                // call has the lowest call ID (by string comparison)
                if (existingCall.state === 'wait_local_media' ||
                        existingCall.state === 'create_offer' ||
                        existingCall.callId > call.callId) {
                    logger.log(
                        "Glare detected: answering incoming call " + call.callId +
                        " and canceling outgoing call " + existingCall.callId,
                    );
                    existingCall.replacedBy(call);
                    call.answer();
                } else {
                    logger.log(
                        "Glare detected: rejecting incoming call " + call.callId +
                        " and keeping outgoing call " + existingCall.callId,
                    );
                    call.hangup(CallErrorCode.Replaced, true);
                }
            } else {
                this.client.emit("Call.incoming", call);
            }
        } else if (event.getType() === 'm.call.answer') {
            if (!call) {
                return;
            }
            if (event.getSender() === this.client.credentials.userId) {
                if (call.state === 'ringing') {
                    call.onAnsweredElsewhere(content);
                }
            } else {
                call.receivedAnswer(content);
            }
        } else if (event.getType() === 'm.call.candidates') {
            if (event.getSender() === this.client.credentials.userId) {
                return;
            }
            if (!call) {
                // store the candidates; we may get a call eventually.
                if (!this.candidatesByCall.has(content.call_id)) {
                    this.candidatesByCall.set(content.call_id, []);
                }
                this.candidatesByCall.set(content.call_id, this.candidatesByCall.get(
                    content.call_id,
                ).concat(content.candidates));
            } else {
                for (const cand of content.candidates) {
                    call.gotRemoteIceCandidate(cand);
                }
            }
        } else if (event.getType() === 'm.call.hangup') {
            // Note that we also observe our own hangups here so we can see
            // if we've already rejected a call that would otherwise be valid
            if (!call) {
                // if not live, store the fact that the call has ended because
                // we're probably getting events backwards so
                // the hangup will come before the invite
                call = createNewMatrixCall(this.client, event.getRoomId());
                if (call) {
                    call.callId = content.call_id;
                    call.initWithHangup(event);
                    this.calls.set(content.call_id, call);
                }
            } else {
                if (call.state !== 'ended') {
                    call.onHangupReceived(content);
                    this.calls.delete(content.call_id);
                }
            }
        }
    }
}