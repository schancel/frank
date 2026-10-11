/** Provisional D1–D11. These APIs provide no directory authentication. */
export {
  deriveRoleLeaves,
  deriveBip39RoleLeaves,
  matchLocalRolePoints,
  RoleKeyError,
} from './roles.js'
export type {
  Role,
  RolePoint,
  RoleLeaf,
  RoleLeaves,
  RoleDerivation,
  Bip39RoleDerivation,
  ExpectedRolePoints,
  LocalPointMatch,
  RoleKeyErrorCode,
} from './roles.js'
