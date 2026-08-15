/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores cloned state snapshots. Popped snapshots are returned directly
 * since they are already detached.
 */
export class UndoStack<S> {
	private stack: S[] = [];

	constructor(private readonly clone: (state: S) => S = structuredClone) {}

	/** Push a clone of the given state onto the stack. */
	push(state: S): void {
		this.stack.push(this.clone(state));
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
