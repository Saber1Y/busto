// TypeScript (6.0.3) fails to surface @qvac/sdk's star-exported model constants
// from its ~19k-line generated models.d.ts (`export * from "./models/registry"`),
// even though they exist at runtime (verified via the installed package + the C0
// smoke). Declare the ones Custos uses with the SDK's own descriptor shape
// (`modelDescriptorSchema`: only `src` is required). This surfaces a real export's
// type — it is NOT a type suppression.
declare module "@qvac/sdk" {
  interface QvacModelDescriptor {
    readonly src: string;
    readonly name?: string;
    readonly modelId?: string;
    readonly registryPath?: string;
    readonly registrySource?: string;
    readonly blobCoreKey?: string;
    readonly expectedSize?: number;
    readonly sha256Checksum?: string;
    readonly engine?: string;
  }
  export const LLAMA_3_2_1B_INST_Q4_0: QvacModelDescriptor;
}

export {};
