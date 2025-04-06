import type { DefineAPI, SDK } from "caido:plugin";
import { RequestSpec } from "caido:utils";
import * as path from "path";
import { writeFile, readFile } from "fs/promises";
import { Response, Settings } from "./types";

const DEFAULT_SETTINGS: Settings = {
  port: 3333,
  host: "localhost",
  filterInScope: true,
}

let globalSettings: Settings | null = null;

function ok<T>(data: T): Response<T> {
  return {
    success: true,
    data,
  }
}

function error(message: string): Response<never> {
  return {
    success: false,
    error: message,
  }
}

const getSettingsFilePath = (sdk: SDK) => {
  return path.join(sdk.meta.path(), "settings.json");
}

const saveSettings = async (sdk: SDK, settings: Settings) => {
  const settingsFilePath = getSettingsFilePath(sdk);

  try {
    await writeFile(settingsFilePath, JSON.stringify(settings, null, 2));
    sdk.console.log(`Settings saved to ${settingsFilePath}`);


    globalSettings = settings;

    return ok(settings);
  } catch (err) {
    sdk.console.error(`Failed to save settings: ${err}`);

    return error(`Failed to save settings: ${err}`);
  }
}

const getSettings = async (sdk: SDK): Promise<Response<Settings>> => {
  const settingsFilePath = getSettingsFilePath(sdk);

  sdk.console.log(`Loading settings from ${settingsFilePath}`);

  try {
    const settings = await readFile(settingsFilePath, "utf-8");
    return ok(JSON.parse(settings) as Settings);
  } catch (err) {
    sdk.console.error(`Failed to read settings: ${err}`);
    return ok(DEFAULT_SETTINGS)
  }
}

export type API = DefineAPI<{
  saveSettings: typeof saveSettings;
  getSettings: typeof getSettings;
}>;



export function init(sdk: SDK<API>) {
  sdk.api.register("saveSettings", saveSettings);
  sdk.api.register("getSettings", getSettings);

  sdk.events.onInterceptResponse(async (sdk, request, response) => {
    if (!globalSettings) {
      const settingsResponse = await getSettings(sdk)
      if (settingsResponse.success) {
        globalSettings = settingsResponse.data;
      } else {
        sdk.console.error(`jxscout-caido: failed to load settings ${settingsResponse.error}`);
        globalSettings = DEFAULT_SETTINGS;
      }
    }

    const settings = globalSettings;

    if (settings.filterInScope && !sdk.requests.inScope(request)) {
      return;
    }

    const requestSpec = new RequestSpec("http://" + settings.host);
    requestSpec.setPath("/caido-ingest");
    requestSpec.setPort(settings.port);
    requestSpec.setMethod("POST");
    requestSpec.setHeader("content-type", "application/json");
    requestSpec.setBody(
      JSON.stringify({
        requestUrl: request.getUrl(),
        request: request.getRaw().toText(),
        response: response.getRaw().toText(),
      })
    );

    try {
      await sdk.requests.send(requestSpec);
    } catch (err) {
      sdk.console.error(`jxscout-caido: failed to send request ${err}`);
    }
  });
}
