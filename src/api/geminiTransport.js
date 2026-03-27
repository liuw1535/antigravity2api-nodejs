import { httpRequest, httpStreamRequest } from "../utils/httpClient.js";

export async function runAxiosSseStream({
  url,
  headers,
  data,
  timeout,
  proxy = null,
  processor,
} = {}) {
  const response = await httpStreamRequest({
    method: "POST",
    url,
    headers,
    data,
    timeout,
    proxy,
  });

  response.data.on("data", (chunk) => {
    processor.processChunk(chunk);
  });

  await new Promise((resolve, reject) => {
    response.data.on("end", () => {
      processor.close();
      resolve();
    });
    response.data.on("error", reject);
  });
}

export async function runNativeSseStream({
  streamResponse,
  processor,
  onErrorChunk,
} = {}) {
  let errorBody = "";
  let statusCode = null;

  await new Promise((resolve, reject) => {
    streamResponse
      .onStart(({ status }) => {
        statusCode = status;
      })
      .onData((chunk) => {
        if (statusCode !== 200) {
          errorBody += chunk;
          if (onErrorChunk) onErrorChunk(chunk);
        } else {
          processor.processChunk(chunk);
        }
      })
      .onEnd(() => {
        processor.close();
        if (statusCode !== 200) {
          reject({ status: statusCode, message: errorBody });
        } else {
          resolve();
        }
      })
      .onError(reject);
  });
}

export async function postJsonAndParse({
  useAxios,
  requester,
  url,
  headers,
  body,
  timeout,
  proxy = null,
  requesterConfig,
  dumpId,
  dumpFinalRawResponse,
  rawFormat = "json",
} = {}) {
  if (useAxios) {
    if (dumpId) {
      const resp = await httpRequest({
        method: "POST",
        url,
        headers,
        data: body,
        timeout,
        proxy,
        responseType: "text",
      });
      const rawText =
        typeof resp.data === "string"
          ? resp.data
          : JSON.stringify(resp.data, null, 2);
      await dumpFinalRawResponse(dumpId, rawText, rawFormat);
      return JSON.parse(rawText);
    }

    return (
      await httpRequest({
        method: "POST",
        url,
        headers,
        data: body,
        timeout,
        proxy,
      })
    ).data;
  }

  if (!requester) {
    throw new Error("native requester is required when useAxios=false");
  }

  const response = await requester.antigravity_fetch(url, requesterConfig);
  if (response.status !== 200) {
    const errorBody = await response.text();
    if (dumpId) await dumpFinalRawResponse(dumpId, errorBody, "txt");
    throw { status: response.status, message: errorBody };
  }

  const rawText = await response.text();
  if (dumpId) await dumpFinalRawResponse(dumpId, rawText, rawFormat);
  return JSON.parse(rawText);
}
