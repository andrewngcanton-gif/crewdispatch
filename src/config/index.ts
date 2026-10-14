// index.ts — the CrewDispatch configuration module (M1 batch 4, Command Code only).
//
// One provider, no edition/provider selector. The persisted config is versioned
// and atomic; model selection is a pure function of the config and the local
// instant; the read view reports CLI/catalog provenance honestly.
export * from "./schema";
export * from "./select";
export * from "./settings";
