import { initWasm, Resvg } from "@resvg/resvg-wasm";
import * as fs from "fs";
import * as path from "path";
import { Log } from "../utils/Log";
import {
  ICON_BG_COLOR_DEFAULT,
  ICON_FG_COLOR_DEFAULT,
} from "../types/IconColorDefaults";

// esbuild sets __dirname to out/ at runtime, so the WASM file is copied alongside extension.js.
const WASM_PATH = path.join(__dirname, "resvg.wasm");

class PngIconService {
  private wasmReady = false;
  private initPromise: Promise<void> | null = null;
  private cachedSmall: Buffer | null = null; // 180×180 — apple-touch-icon
  private cachedLarge: Buffer | null = null; // 512×512 — manifest app icon
  private lastBg = "";
  private lastFg = "";

  private async initWasmOnce(): Promise<void> {
    if (this.wasmReady) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const wasmBuffer = fs.readFileSync(WASM_PATH);
        await initWasm(wasmBuffer);
        this.wasmReady = true;
      })();
    }
    await this.initPromise;
  }

  private async render(
    svgPath: string,
    bgColor: string,
    fgColor: string
  ): Promise<void> {
    await this.initWasmOnce();
    const svgSource = fs
      .readFileSync(svgPath, "utf8")
      .replace(new RegExp(ICON_BG_COLOR_DEFAULT, "gi"), bgColor)
      .replace(new RegExp(ICON_FG_COLOR_DEFAULT, "gi"), fgColor);

    // 180×180 — apple-touch-icon (iOS homescreen)
    const resvgSmall = new Resvg(svgSource, {
      fitTo: { mode: "width", value: 180 },
    });
    const renderedSmall = resvgSmall.render();
    this.cachedSmall = Buffer.from(renderedSmall.asPng());
    renderedSmall.free();
    resvgSmall.free();

    // 512×512 — manifest large icon (Android PWA / install prompt)
    const resvgLarge = new Resvg(svgSource, {
      fitTo: { mode: "width", value: 512 },
    });
    const renderedLarge = resvgLarge.render();
    this.cachedLarge = Buffer.from(renderedLarge.asPng());
    renderedLarge.free();
    resvgLarge.free();

    this.lastBg = bgColor;
    this.lastFg = fgColor;
  }

  private needsRender(bgColor: string, fgColor: string): boolean {
    return (
      !this.cachedSmall || bgColor !== this.lastBg || fgColor !== this.lastFg
    );
  }

  async getSmall(
    svgPath: string,
    bgColor: string,
    fgColor: string
  ): Promise<Buffer | null> {
    if (this.needsRender(bgColor, fgColor)) {
      try {
        await this.render(svgPath, bgColor, fgColor);
      } catch (err) {
        Log.warn(`PngIconService: render failed: ${err}`);
        return null;
      }
    }
    return this.cachedSmall;
  }

  async getLarge(
    svgPath: string,
    bgColor: string,
    fgColor: string
  ): Promise<Buffer | null> {
    if (this.needsRender(bgColor, fgColor)) {
      try {
        await this.render(svgPath, bgColor, fgColor);
      } catch (err) {
        Log.warn(`PngIconService: render failed: ${err}`);
        return null;
      }
    }
    return this.cachedLarge;
  }
}

export const pngIconService = new PngIconService();
