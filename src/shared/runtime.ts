import type { PopupState, RuntimeMessage, TrailSession } from "./types";

type RuntimeResponseMap = {
  GET_POPUP_STATE: PopupState;
  START_GROUP_RECORDING: TrailSession;
  START_WINDOW_RECORDING: TrailSession;
  STOP_RECORDING: TrailSession | undefined;
  GENERATE_FROM_CURRENT_GROUP: TrailSession;
  GENERATE_FROM_CURRENT_WINDOW: TrailSession;
  OPEN_SESSION: undefined;
  DELETE_SESSION: undefined;
};

export async function sendMessage<T extends RuntimeMessage>(
  message: T
): Promise<RuntimeResponseMap[T["type"]]> {
  const response = await chrome.runtime.sendMessage(message);

  if (response && typeof response === "object" && "error" in response) {
    throw new Error(String(response.error));
  }

  return response;
}
