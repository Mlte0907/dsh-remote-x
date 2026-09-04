import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "dsh-remote-x";
/** Services required before apply runs. */
declare const inject: string[];
/** Plugin config. */
interface Config {
  /** Max viewport width (px) the mobile layer applies to. Default 768. */
  breakpoint?: number;
  /** LAN proxy port phones connect through. Default 3081; 0 = not deployed. */
  proxyPort?: number;
  /** Section label. Default '远程控制'. */
  title?: string;
  /** Manual override for the login token (auto-detected by default). */
  token?: string;
  /** Proxy access-key for QR entry URL. When set, QR links use ?key= instead of ?token=. */
  accessKey?: string;
}
declare const Config: z<Config>;
declare function apply(ctx: Context, config?: Config): Promise<void>;
//#endregion
export { Config, apply, inject, name };