import { EventEmitter } from 'node:events';

/**
 * Internal event bus. Modules emit domain events (modAction, ticketClosed, memberVerified…)
 * so that logs / integrations (ForgeHook, ForgeArchive) can react without coupling.
 */
export class Bus extends EventEmitter {
  constructor() { super(); this.setMaxListeners(200); }
  publish(event, payload) {
    this.emit(event, payload);
    this.emit('*', { event, payload, at: Date.now() });
  }
}

export const EVENTS = [
  'action', 'modAction', 'memberJoin', 'memberLeave', 'memberBan', 'memberUnban', 'messageDelete', 'messageEdit',
  'ticketOpen', 'ticketClose', 'giveawayEnd', 'levelUp', 'suggestionNew', 'suggestionStatus', 'raidDetected',
  'automodTrigger', 'backupCreated', 'archiveCreated', 'verificationPassed', 'pollEnd', 'reminder', 'inviteJoin', 'birthday', 'achievement', 'custom',
];
