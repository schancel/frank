/** Stable cross-language error categories (README section 10). */
export type ErrorCategory =
  | 'frame'
  | 'unsupported'
  | 'resource'
  | 'malformed'
  | 'noncanonical'
  | 'schema'
  | 'semantic'
  | 'cryptographic'

/**
 * Section 9 stage that determined the failure. `cbor` marks the standalone
 * restricted-CBOR API, which has no frame stages.
 */
export type ErrorStage =
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8.1'
  | '8.2'
  | '8.3'
  | '8.4'
  | '9'
  | 'cbor'

/** Which CBOR pass raised the error, when the failure is a CBOR-stage failure. */
export type CborPass = 'A' | 'B'

export class FrankCodecError extends Error {
  readonly category: ErrorCategory
  readonly stage: ErrorStage
  readonly pass?: CborPass
  /** Human-readable location, for example `root/payload/child[2]`. */
  readonly location: string
  /** The message without the category/stage/location prefix. */
  readonly detail: string

  constructor(
    category: ErrorCategory,
    stage: ErrorStage,
    message: string,
    location = 'root',
    pass?: CborPass,
  ) {
    super(
      `${category} (stage ${stage}${
        pass ? pass : ''
      }) at ${location}: ${message}`,
    )
    this.name = 'FrankCodecError'
    this.category = category
    this.stage = stage
    this.pass = pass
    this.location = location
    this.detail = message
    Object.setPrototypeOf(this, FrankCodecError.prototype)
  }
}

/**
 * The caller supplied an invalid validation context (for example a prior
 * directory statement that is itself invalid). This is not a case outcome.
 */
export class FrankContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrankContextError'
    Object.setPrototypeOf(this, FrankContextError.prototype)
  }
}
