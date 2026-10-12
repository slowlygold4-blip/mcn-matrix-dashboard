import { PublicWebProvider } from "./public-web.mjs";

export function createProvider(name, settings, options = {}) {
  if (name === "public-web") return new PublicWebProvider(settings, options);
  if (name === "manual") {
    return { collect: async () => { throw new Error("手动导入目标不会自动采集，请通过工作台导入标准 JSON"); } };
  }
  throw new Error(`未知数据源：${name}`);
}
