import type { Caido } from "@caido/sdk-frontend";

import type { PluginStorage } from "./types";

import "./styles/style.css";

type CaidoSDK = Caido;

const Page = "/jx" as const;

const getJXScoutPort = (sdk: CaidoSDK) => {
  const storage = sdk.storage.get() as PluginStorage | undefined;

  if (storage) {
    return storage.jxscoutPort;
  }

  return "3333";
};

const addPage = (sdk: CaidoSDK) => {
  const jxscoutPort = getJXScoutPort(sdk);

  const body = document.createElement("div");
  body.className = "jx";
  body.innerHTML = `
    <div class="jxscout-config">
      <span>Port:</span>
      <input name="jxscout-port" type="text">${jxscoutPort}</span>
    </div>
  `;

  sdk.navigation.addPage(Page, {
    body,
  });
};

export const init = (sdk: CaidoSDK) => {
  // Register page
  addPage(sdk);

  // Register sidebar
  sdk.sidebar.registerItem("JX", Page, {
    icon: "fas fa-rocket",
  });
};
