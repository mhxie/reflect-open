import {
  WritableStore,
  type ClockService,
  type FinishedOperation,
  type Operation,
  type OperationHandle,
  type OperationOptions,
  type ProgressPort,
  type Store,
} from '@reflect/core'

/**
 * The app-wide list of visible background operations, newest last.
 * Listeners run synchronously inside the mutation that caused them.
 */
export interface OperationsService extends ProgressPort, Store<readonly Operation[]> {
  /**
   * Removes an operation by id.
   */
  dismiss(id: number): void
  /**
   * The background operations that finished this session, newest first, as
   * the activity tray's history lists them. The array changes identity when
   * an entry is added; {@link subscribe} reports it.
   */
  getHistory(): readonly FinishedOperation[]
}

/**
 * How many finished background operations the history keeps.
 */
const HISTORY_LIMIT = 8

/**
 * How long a warning or failure lingers after the minimum visible time.
 */
export const LINGER_MS = 8000
/**
 * Once shown, an entry stays visible at least this long, so a fast operation
 * does not flash for a single frame.
 */
export const MIN_VISIBLE_MS = 1200

export interface OperationsServiceDeps {
  readonly clock: ClockService
}

class OperationHandleImpl implements OperationHandle {
  readonly #service: OperationsServiceImpl
  readonly #clock: ClockService
  readonly #id: number
  readonly #shownAt: number
  readonly #persistent: boolean

  constructor(
    service: OperationsServiceImpl,
    clock: ClockService,
    id: number,
    persistent: boolean,
  ) {
    this.#service = service
    this.#clock = clock
    this.#id = id
    this.#shownAt = clock.now()
    this.#persistent = persistent
  }

  progress(done: number, total: number): void {
    this.#service.patch(this.#id, { progress: { done, total } })
  }

  done(): void {
    this.#removeAfterMinimum(0)
  }

  warn(message: string): void {
    this.#service.patch(this.#id, { status: 'warning', message })
    this.#removeAfterMinimum(LINGER_MS)
  }

  fail(message: string): void {
    this.#service.patch(this.#id, { status: 'failed', message })
    this.#removeAfterMinimum(LINGER_MS)
  }

  dismiss(): void {
    this.#service.dismiss(this.#id)
  }

  #removeAfterMinimum(extra: number): void {
    if (this.#persistent && extra > 0) {
      return
    }
    const visibleFor = this.#clock.now() - this.#shownAt
    const wait = Math.max(0, MIN_VISIBLE_MS - visibleFor) + extra
    if (wait === 0) {
      this.#service.dismiss(this.#id)
    } else {
      this.#clock.setTimeout(() => this.#service.dismiss(this.#id), wait)
    }
  }
}

class OperationsServiceImpl implements OperationsService {
  readonly #deps: OperationsServiceDeps
  #nextId = 1
  readonly #operations = new WritableStore<readonly Operation[]>([])
  #history: readonly FinishedOperation[] = []

  constructor(deps: OperationsServiceDeps) {
    this.#deps = deps
  }

  fail(label: string, message: string, options?: OperationOptions): void {
    this.start(label, options).fail(message)
  }

  start(label: string, options?: OperationOptions): OperationHandle {
    const { clock } = this.#deps
    const id = this.#nextId++
    const persistent = options?.persistent ?? false
    this.#operations.set([
      ...this.#operations.get(),
      {
        id,
        label,
        description: options?.description ?? null,
        progress: null,
        status: 'running',
        persistent,
        background: options?.background ?? false,
        action: options?.action ?? null,
        message: null,
      },
    ])
    return new OperationHandleImpl(this, clock, id, persistent)
  }

  readonly get = this.#operations.get

  readonly subscribe = this.#operations.subscribe

  dismiss(id: number): void {
    const removed = this.#operations.get().find((operation) => operation.id === id)
    if (removed === undefined) {
      return
    }
    if (removed.background) {
      const { label, status, message } = removed
      this.#history = [
        { id, label, status, message, endedAt: this.#deps.clock.now() },
        ...this.#history,
      ].slice(0, HISTORY_LIMIT)
    }
    this.#operations.set(this.#operations.get().filter((operation) => operation.id !== id))
  }

  getHistory(): readonly FinishedOperation[] {
    return this.#history
  }

  patch(id: number, change: Partial<Operation>): void {
    let changed = false
    const operations = this.#operations.get().map((operation) => {
      if (operation.id !== id) {
        return operation
      }
      changed = true
      return { ...operation, ...change }
    })
    if (changed) {
      this.#operations.set(operations)
    }
  }
}

export function createOperationsService(deps: OperationsServiceDeps): OperationsService {
  return new OperationsServiceImpl(deps)
}
