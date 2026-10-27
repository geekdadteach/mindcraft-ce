// Authoritative task records; cancellation requests are not completion.
import { randomUUID } from 'node:crypto';
const FINAL = new Set(['succeeded', 'failed', 'cancelled']);
export class TaskLifecycle {
  constructor({emit = () => {}} = {}) {
    this.emit = emit; this.sequence = 0; this.active = null;
  }
  begin(label, {goalId = null} = {}) {
    if (this.active) throw new Error('Cannot start task while another task owns execution');
    const task = {id: 'bob-task-' + randomUUID(), goalId, label,
      state: 'running', reason: null, startedAt: Date.now(), settled: false};
    this.active = task;
    this.emit({type: 'task.started', taskId: task.id, goalId, label});
    return task;
  }
  requestCancel(task, reason = 'superseded') {
    if (!task || FINAL.has(task.state) || task.settled) return false;
    if (task.state === 'running') {
      task.state = 'cancel_requested'; task.reason = reason;
      this.emit({type: 'task.cancel_requested', taskId: task.id, label: task.label, reason});
    }
    return true;
  }
  abandon(task, reason = 'cancel_timeout') {
    if (!task || task.settled || task.state === 'uncertain') return false;
    task.state = 'uncertain'; task.reason = reason;
    if (this.active === task) this.active = null;
    this.emit({type: 'task.uncertain', taskId: task.id, label: task.label, reason});
    return true;
  }
  settle(task, {success = false, interrupted = false, timedout = false, error = null} = {}) {
    if (!task || task.settled) return false;
    task.settled = true;
    if (task.state === 'uncertain' || this.active !== task) {
      this.emit({type: 'task.late_settlement', taskId: task.id, label: task.label,
        success, interrupted, timedout, error: error ? String(error).slice(0,160) : null});
      return false;
    }
    task.state = interrupted || task.state === 'cancel_requested' ? 'cancelled' : (success ? 'succeeded' : 'failed');
    task.reason = error ? String(error).slice(0,160) : task.reason;
    this.active = null;
    this.emit({type: 'task.finished', taskId: task.id, label: task.label, goalId: task.goalId, state: task.state, reason: task.reason, timedout});
    return true;
  }
}
