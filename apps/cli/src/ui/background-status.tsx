import React from "react";
import { Text } from "ink";

// A short luminance ramp reads as breathing instead of blinking. Keep the dot
// green throughout so its meaning stays stable on every frame.
const PULSE_COLORS = ["#245c39", "#348a54", "#46c77e", "#78e8a5", "#46c77e", "#348a54"] as const;

export function BackgroundStatus({ label }: { label: string }): React.ReactElement {
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % PULSE_COLORS.length);
    }, 240);
    timer.unref();
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <Text color={PULSE_COLORS[frame]}>●</Text>
      <Text color="green">{` ${label}`}</Text>
    </>
  );
}
