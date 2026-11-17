import { describe, expect, it, vi } from "vitest";
import { createInstallController, registerServiceWorker, subscribeOnline, type BeforeInstallPromptEvent } from "./pwa";

/** What a browser fires: an Event that also carries prompt() and userChoice. */
function offer(outcome: "accepted" | "dismissed" = "accepted", options: { fail?: boolean } = {}) {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as BeforeInstallPromptEvent;
  const prompt = vi.fn(async () => { if (options.fail) throw new Error("not allowed"); });
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) });
  return { event, prompt };
}

describe("createInstallController", () => {
  it("offers nothing until the browser does", () => {
    const controller = createInstallController(new EventTarget(), () => false);
    expect(controller.canInstall()).toBe(false);
  });

  it("holds the browser's offer, suppresses its own prompt, and tells subscribers", () => {
    const target = new EventTarget();
    const controller = createInstallController(target, () => false);
    const listener = vi.fn();
    controller.subscribe(listener);
    const { event } = offer();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(controller.canInstall()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("shows the browser's dialog on install and then stops offering: the offer is single-use", async () => {
    const target = new EventTarget();
    const controller = createInstallController(target, () => false);
    const { event, prompt } = offer("accepted");
    target.dispatchEvent(event);
    expect(await controller.install()).toBe("accepted");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(controller.canInstall()).toBe(false);
    expect(await controller.install()).toBe("unavailable");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("reports a dismissal, and offers again only when the browser does", async () => {
    const target = new EventTarget();
    const controller = createInstallController(target, () => false);
    target.dispatchEvent(offer("dismissed").event);
    expect(await controller.install()).toBe("dismissed");
    expect(controller.canInstall()).toBe(false);
    target.dispatchEvent(offer().event);
    expect(controller.canInstall()).toBe(true);
  });

  it("treats a prompt that throws as unavailable rather than crashing", async () => {
    const target = new EventTarget();
    const controller = createInstallController(target, () => false);
    target.dispatchEvent(offer("accepted", { fail: true }).event);
    expect(await controller.install()).toBe("unavailable");
  });

  it("hides the offer once the app is installed", () => {
    const target = new EventTarget();
    const controller = createInstallController(target, () => false);
    const listener = vi.fn();
    controller.subscribe(listener);
    target.dispatchEvent(offer().event);
    target.dispatchEvent(new Event("appinstalled"));
    expect(controller.canInstall()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    target.dispatchEvent(offer().event);
    expect(controller.canInstall()).toBe(false);
  });

  it("never offers while the app is already running installed", () => {
    const target = new EventTarget();
    const controller = createInstallController(target, () => true);
    target.dispatchEvent(offer().event);
    expect(controller.canInstall()).toBe(false);
  });

  it("stops telling a subscriber that has left", () => {
    const target = new EventTarget();
    const controller = createInstallController(target, () => false);
    const listener = vi.fn();
    const stop = controller.subscribe(listener);
    stop();
    target.dispatchEvent(offer().event);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("subscribeOnline", () => {
  it("fires on both online and offline, and not after unsubscribing", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    const stop = subscribeOnline(target, listener);
    target.dispatchEvent(new Event("offline"));
    target.dispatchEvent(new Event("online"));
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    target.dispatchEvent(new Event("offline"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("registerServiceWorker", () => {
  it("registers a relative worker with a relative scope, so it works under any proxy prefix", async () => {
    const register = vi.fn(async () => ({}));
    expect(await registerServiceWorker({ serviceWorker: { register } } as never)).toBe(true);
    expect(register).toHaveBeenCalledWith("./sw.js", { scope: "./" });
  });

  it("is quiet when the browser has no service workers", async () => {
    expect(await registerServiceWorker({} as never)).toBe(false);
  });

  it("swallows a failed registration: the app works without a worker", async () => {
    const register = vi.fn(async () => { throw new Error("blocked"); });
    expect(await registerServiceWorker({ serviceWorker: { register } } as never)).toBe(false);
  });
});
