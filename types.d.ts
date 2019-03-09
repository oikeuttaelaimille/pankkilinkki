type XPathResult = any;
type XPathNSResolver = any;
type Node = any;
type Attr = any;

declare module "node-forge" {
  export namespace pki {
    export type Certificate = any;
    export type CAStore = any;
  }
}

declare module "xml-crypto" {
  export type ComputeSignatureOptions = any;
}
