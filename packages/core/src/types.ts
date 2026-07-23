export type BrickId = string
export type Tier = 'brick' | 'composed' | 'inject'

export interface BrickParam {
  type: 'string' | 'enum' | 'boolean'
  values?: string[]
  default?: string | boolean
  prompt?: string
}

export interface FileSpec { from: string; to: string }
export interface FragmentSpec { target: string; from: string; strategy: 'yaml' | 'lines' }
export interface InjectSpec { target: string; marker: string; from: string }

export interface Brick {
  name: BrickId
  slot: string
  summary: string
  dir: string
  requires: Record<string, string>
  provides: string[]
  params: Record<string, BrickParam>
  files: FileSpec[]
  fragments: FragmentSpec[]
  inject: InjectSpec[]
}

export interface SlotDef { name: string; single: boolean }

export interface Registry {
  bricks: Map<BrickId, Brick>
  slots: SlotDef[]
}

export type ParamValue = string | boolean
export type ParamBag = Record<string, ParamValue>

export interface Manifest {
  bricks: Record<BrickId, ParamBag>
  overrides: Record<string, Record<string, unknown>>
}

export interface ResolvedBrick {
  brick: Brick
  params: ParamBag
  inferred: boolean
}

export interface Graph {
  bricks: ResolvedBrick[]
}

export type ResolutionError =
  | { kind: 'ambiguous'; capability: string; candidates: BrickId[]; requiredBy: BrickId }
  | { kind: 'unsatisfiable'; capability: string; requiredBy: BrickId }
  | { kind: 'slot-conflict'; slot: string; bricks: BrickId[] }
  | { kind: 'cycle'; path: BrickId[] }
  | { kind: 'unknown-brick'; name: string; suggestions: BrickId[] }
  | { kind: 'missing-param'; brick: BrickId; param: string; schema: BrickParam }
  | { kind: 'invalid-param'; brick: BrickId; param: string; value: unknown; reason: string }

export type ResolveResult =
  | { ok: true; graph: Graph }
  | { ok: false; errors: ResolutionError[] }

export type FileOp =
  | { kind: 'create'; path: string; contents: string; owner: BrickId; tier: Tier }
  | { kind: 'overwrite'; path: string; contents: string; owner: BrickId; tier: Tier; prevHash: string }
  | { kind: 'compose'; path: string; contents: string; contributors: BrickId[] }
  | { kind: 'inject'; path: string; marker: string; contents: string; owner: BrickId }
  | { kind: 'delete'; path: string; owner: BrickId }
  // `contents` is what stacky *would* have written. apply() dumps it to
  // `<path>.stacky-new` so you can diff. Absent when the blocked op was a deletion.
  | { kind: 'conflict'; path: string; reason: 'user-modified'; contents?: string }

export interface LockEntry {
  path: string
  owner: BrickId | '@composed'
  tier: Tier
  hash: string
}

export interface Lockfile {
  version: 1
  bricks: Record<BrickId, ParamBag>
  files: LockEntry[]
}
