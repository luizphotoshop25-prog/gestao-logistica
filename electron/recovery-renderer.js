const status = document.querySelector("#status");
const detail = document.querySelector("#detail");
const checkButton = document.querySelector("#check");
const downloadButton = document.querySelector("#download");
const installButton = document.querySelector("#install");

function render(state = {}) {
  const updaterEnabled = Boolean(state.updaterEnabled);
  const updateState = state.state?.status || "idle";
  if (!updaterEnabled) {
    status.textContent = "A atualização automática não está disponível nesta instalação.";
  } else if (updateState === "available") {
    status.textContent = `Correção ${state.state.version || "mais recente"} disponível.`;
  } else if (updateState === "downloading") {
    status.textContent = `Baixando correção: ${Math.round(state.state.percent || 0)}%.`;
  } else if (updateState === "downloaded") {
    status.textContent = `Correção ${state.state.version || "mais recente"} pronta para instalar.`;
  } else if (updateState === "error") {
    status.textContent = state.state.message || "Não foi possível consultar a atualização.";
  } else {
    status.textContent = "Verificando se há uma correção disponível…";
  }
  checkButton.disabled = !updaterEnabled;
  downloadButton.disabled = !updaterEnabled || updateState !== "available";
  installButton.disabled = !updaterEnabled || updateState !== "downloaded";
}

checkButton.addEventListener("click", () => void window.gestaoRecovery.check());
downloadButton.addEventListener("click", () => void window.gestaoRecovery.download());
installButton.addEventListener("click", () => void window.gestaoRecovery.install());
window.gestaoRecovery.onState(render);
void window.gestaoRecovery.state().then(render);
