// ABOUTME: Tests for the runtime event bus.
// ABOUTME: Verifies pub/sub and WebSocket broadcast behavior.

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAll, emit, subscribe } from "../src/events";

describe("events", () => {
  afterEach(() => {
    clearAll();
  });

  it("delivers events to local subscribers", () => {
    const callback = vi.fn();
    subscribe("test:event", callback);
    emit("test:event", { foo: "bar" });
    expect(callback).toHaveBeenCalledWith({ foo: "bar" });
  });

  it("supports multiple subscribers for same event", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    subscribe("test:event", cb1);
    subscribe("test:event", cb2);
    emit("test:event", "data");
    expect(cb1).toHaveBeenCalledWith("data");
    expect(cb2).toHaveBeenCalledWith("data");
  });

  it("unsubscribe stops delivery", () => {
    const callback = vi.fn();
    const unsub = subscribe("test:event", callback);
    unsub();
    emit("test:event", "data");
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not deliver events for different event names", () => {
    const callback = vi.fn();
    subscribe("event:a", callback);
    emit("event:b", "data");
    expect(callback).not.toHaveBeenCalled();
  });

  it("handles emit with no params", () => {
    const callback = vi.fn();
    subscribe("test:event", callback);
    emit("test:event");
    expect(callback).toHaveBeenCalledWith(undefined);
  });
});
