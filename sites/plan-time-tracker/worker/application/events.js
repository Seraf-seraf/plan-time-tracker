/** Explicit, ordered observers which only prepare writes in the caller's transaction. */
export class TransactionalEvents {
  #observers;

  constructor(observers) {
    this.#observers = new Map(
      Object.entries(observers).map(([type, handlers]) => [type, [...handlers]]),
    );
  }

  emit(transaction, event) {
    try {
      const observers = this.#observers.get(event.type);
      if (!observers) throw new Error('Unknown transactional event: ' + event.type);
      for (const observer of observers) {
        const result = typeof observer === 'function'
          ? observer(transaction, event)
          : observer.observe(transaction, event);
        if (result && typeof result.then === 'function') {
          // Observers cannot perform work after this synchronous preparation phase.
          Promise.resolve(result).catch(() => {});
          throw new Error('Transactional observers must be synchronous.');
        }
      }
    } catch (error) {
      transaction.abort(error);
      throw error;
    }
  }
}
