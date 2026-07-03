import React, { useCallback, useLayoutEffect, useState } from "react";

interface ExecutingStepHighlightProps {
  containerRef: React.RefObject<HTMLElement | null>;
  layoutKey: string;
  targetSelector: string;
  visible: boolean;
  borderClassName?: string;
  testId?: string;
}

/**
 * A single overlay owned by a step/chip list rather than an individual item.
 * Moving the same element between item bounds lets CSS animate execution
 * advancing while keeping the running item border independent from row content.
 */
export function ExecutingStepHighlight({
  containerRef,
  layoutKey,
  targetSelector,
  visible,
  borderClassName = "border-2",
  testId = "executing-step-highlight",
}: ExecutingStepHighlightProps) {
  const [bounds, setBounds] = useState({ top: 0, height: 0, measured: false });

  const measureBounds = useCallback(() => {
    const container = containerRef.current;
    if (!container || !visible) {
      return;
    }

    const target = container.querySelector<HTMLElement>(targetSelector);
    if (!target) {
      setBounds((current) =>
        current.measured ? { top: 0, height: 0, measured: false } : current
      );
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const nextBounds = {
      top: targetRect.top - containerRect.top,
      height: targetRect.height,
      measured: targetRect.height > 0,
    };

    setBounds((current) =>
      current.top === nextBounds.top &&
      current.height === nextBounds.height &&
      current.measured === nextBounds.measured
        ? current
        : nextBounds
    );
  }, [containerRef, targetSelector, visible]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !visible) {
      return;
    }

    const target = container.querySelector<HTMLElement>(targetSelector);
    const frameIds: number[] = [];
    frameIds.push(window.requestAnimationFrame(measureBounds));
    frameIds.push(
      window.requestAnimationFrame(() => {
        frameIds.push(window.requestAnimationFrame(measureBounds));
      })
    );
    const timerIds = [
      window.setTimeout(measureBounds, 120),
      window.setTimeout(measureBounds, 320),
    ];
    const resizeObserver = new ResizeObserver(measureBounds);
    resizeObserver.observe(container);
    if (target) {
      resizeObserver.observe(target);
    }

    window.addEventListener("resize", measureBounds);
    window.addEventListener("animationend", measureBounds, true);
    window.addEventListener("transitionend", measureBounds, true);

    return () => {
      frameIds.forEach((frameId) => window.cancelAnimationFrame(frameId));
      timerIds.forEach((timerId) => window.clearTimeout(timerId));
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureBounds);
      window.removeEventListener("animationend", measureBounds, true);
      window.removeEventListener("transitionend", measureBounds, true);
    };
  }, [containerRef, layoutKey, measureBounds, targetSelector, visible]);

  if (!visible) return null;

  return (
    <div
      data-testid={testId}
      className={`pointer-events-none absolute inset-x-0 top-0 z-raised ${borderClassName} border-status-idle animate-pulse-custom transition-[transform,height,opacity] duration-300 ease-out ${
        bounds.measured ? "opacity-100" : "opacity-0"
      }`}
      style={{
        height: bounds.height,
        transform: `translateY(${bounds.top}px)`,
      }}
      aria-hidden="true"
    />
  );
}
