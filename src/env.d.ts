/// <reference types="@crxjs/vite-plugin/client" />

declare module "type-fest" {
  export type IsStringLiteral<T> = T extends string ? (string extends T ? false : true) : false;
}

