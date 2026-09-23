import type { ReactElement } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";

export function Hint({ label, children, side = "bottom" }: { label: string; children: ReactElement; side?: "top" | "right" | "bottom" | "left" }) {
  return <Tooltip.Root>
    <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content className="app-tooltip" side={side} sideOffset={7}>
        {label}<Tooltip.Arrow className="app-tooltip-arrow" />
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>;
}
