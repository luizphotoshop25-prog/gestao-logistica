import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, FileSpreadsheet, MailCheck, RefreshCw, ShieldCheck } from "lucide-react";

type Props = {
  busy: boolean;
  lastSync: string | null;
  onThunderbird(): void;
  onSiwin(): void;
  onImport(): void;
};

export function IntegrationMenu({ busy, lastSync, onThunderbird, onSiwin, onImport }: Props) {
  const syncLabel = lastSync
    ? new Date(lastSync).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
    : "Ainda não sincronizado";

  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button className="integration-trigger" aria-label="Abrir menu de integrações">
        <RefreshCw size={16} /><span>Integrações</span><ChevronDown size={14} />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="app-menu-content integrations-popover" align="end" sideOffset={9} collisionPadding={12}>
        <DropdownMenu.Label className="app-menu-label">INTEGRAÇÕES LOCAIS</DropdownMenu.Label>
        <div className="integration-readonly"><ShieldCheck size={16} /><span><strong>SIWIN protegido</strong><small>Consultas somente para leitura</small></span></div>
        <DropdownMenu.Separator className="app-menu-separator" />
        <DropdownMenu.Item className="app-menu-item" disabled={busy} onSelect={onThunderbird}>
          <span className="menu-item-icon"><MailCheck size={16} /></span><span><strong>Verificar seleções</strong><small>Ler novos e-mails da EPICS</small></span>
        </DropdownMenu.Item>
        <DropdownMenu.Item className="app-menu-item" disabled={busy} onSelect={onSiwin}>
          <span className="menu-item-icon"><RefreshCw size={16} /></span><span><strong>Sincronizar SIWIN</strong><small>Última consulta: {syncLabel}</small></span>
        </DropdownMenu.Item>
        <DropdownMenu.Item className="app-menu-item" disabled={busy} onSelect={onImport}>
          <span className="menu-item-icon"><FileSpreadsheet size={16} /></span><span><strong>Importar planilha</strong><small>XLSX ou CSV com prévia segura</small></span>
        </DropdownMenu.Item>
        <DropdownMenu.Arrow className="app-menu-arrow" />
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
