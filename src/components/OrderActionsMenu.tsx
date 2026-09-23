import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Clipboard, MoreHorizontal, PanelRightOpen, Play } from "lucide-react";
import { Hint } from "./Hint";

type Props = {
  session: string;
  actionLabel: string;
  disabled?: boolean;
  onOpen(): void;
  onExecute(): void;
  onCopy(): void;
};

export function OrderActionsMenu({ session, actionLabel, disabled, onOpen, onExecute, onCopy }: Props) {
  return <DropdownMenu.Root>
    <Hint label={`Mais ações para ${session}`}>
      <DropdownMenu.Trigger asChild>
        <button className="row-menu-trigger" disabled={disabled} aria-label={`Mais ações para a sessão ${session}`}><MoreHorizontal size={17} /></button>
      </DropdownMenu.Trigger>
    </Hint>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="app-menu-content row-menu-content" align="end" sideOffset={6} collisionPadding={10}>
        <DropdownMenu.Label className="app-menu-label">SESSÃO {session}</DropdownMenu.Label>
        <DropdownMenu.Item className="app-menu-item compact" onSelect={onOpen}><PanelRightOpen size={16} /><span>Abrir ficha completa</span></DropdownMenu.Item>
        {actionLabel !== "Abrir ficha" && <DropdownMenu.Item className="app-menu-item compact" onSelect={onExecute}><Play size={16} /><span>{actionLabel}</span></DropdownMenu.Item>}
        <DropdownMenu.Separator className="app-menu-separator" />
        <DropdownMenu.Item className="app-menu-item compact" onSelect={onCopy}><Clipboard size={16} /><span>Copiar código da sessão</span></DropdownMenu.Item>
        <DropdownMenu.Arrow className="app-menu-arrow" />
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
