(() => {
  const host = document.getElementById("notices");
  const snoozeOptions = (notice) => Array.isArray(notice.snoozeMinutes) ? notice.snoozeMinutes : [];
  const addText = (parent, tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
  };
  const send = (action) => window.gestaoPopup.act(action);
  function render(state) {
    host.replaceChildren();
    for (const notice of (state?.notices || []).slice(0, 3)) {
      const card = document.createElement("article");
      card.className = "notice-card";
      card.dataset.type = notice.type;
      const head = document.createElement("header");
      head.className = "notice-head";
      addText(head, "span", "notice-mark", notice.type === "OVERDUE" ? "!" : "•");
      addText(head, "strong", "notice-title", notice.title);
      card.append(head);
      const close = addText(card, "button", "notice-close", "×");
      close.type = "button";
      close.setAttribute("aria-label", "Fechar aviso");
      close.addEventListener("click", () => send({ action: "close" }));
      if (notice.session) addText(card, "p", "notice-session", `Sessão ${notice.session}`);
      addText(card, "p", "notice-detail", notice.detail);
      const actions = document.createElement("div");
      actions.className = "notice-actions";
      const open = addText(actions, "button", "open-button", "Abrir solicitação");
      open.type = "button";
      open.addEventListener("click", () => send({ action: "open", id: notice.id }));
      const options = snoozeOptions(notice);
      if (options.length) {
        const details = document.createElement("details");
        details.className = "snooze-menu";
        addText(details, "summary", "", "Lembrar depois");
        const menu = document.createElement("div");
        menu.className = "snooze-options";
        for (const minutes of options) {
          const button = addText(menu, "button", "", minutes === 60 ? "1 hora" : `${minutes} min`);
          button.type = "button";
          button.addEventListener("click", () => send({ action: "snooze", id: notice.id, minutes }));
        }
        details.append(menu);
        actions.append(details);
      }
      card.append(actions);
      host.append(card);
    }
    if (Number(state?.overflow) > 0) {
      const overflow = document.createElement("div");
      overflow.className = "overflow-card";
      overflow.append(document.createTextNode(`+${state.overflow} solicitações precisam de atenção`));
      const button = addText(overflow, "button", "", "Ver na Central");
      button.type = "button";
      button.addEventListener("click", () => send({ action: "open-center" }));
      host.append(overflow);
    }
  }
  window.gestaoPopup.onState(render);
})();
