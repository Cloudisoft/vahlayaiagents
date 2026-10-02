import { lazy, type ComponentType } from "react";

const RELOAD_KEY = "vahlay.chunkReload";

// After a deploy, an open tab can ask for a page file that no longer
// exists. Retry briefly (network blips), then reload once to pick up the new
// version instead of leaving a blank page. The flag stops reload loops.
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const mod = await load();
        try {
          sessionStorage.removeItem(RELOAD_KEY);
        } catch {
          // storage unavailable
        }
        return mod;
      } catch (err) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        let reloaded = false;
        try {
          reloaded = sessionStorage.getItem(RELOAD_KEY) === "1";
          if (!reloaded) sessionStorage.setItem(RELOAD_KEY, "1");
        } catch {
          // storage unavailable
        }
        if (!reloaded) {
          window.location.reload();
          return new Promise<never>(() => undefined); // page is reloading
        }
        throw err;
      }
    }
  });
}
