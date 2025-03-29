import { SDK } from "caido:plugin";
import { RequestSpec } from "caido:utils";

export function init(sdk: SDK) {
  sdk.events.onInterceptResponse(async (sdk, request, response) => {
    if (!sdk.requests.inScope(request)) {
      return;
    }

    const requestSpec = new RequestSpec("http://localhost");
    requestSpec.setPath("/caido-ingest");
    requestSpec.setPort(3333);
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
