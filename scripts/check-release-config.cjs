const owner = process.env.GESTAO_UPDATE_GITHUB_OWNER || "";
const repo = process.env.GESTAO_UPDATE_GITHUB_REPO || "";
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
if (!owner || !repo) {
  console.error("Publicação bloqueada: configure GESTAO_UPDATE_GITHUB_OWNER e GESTAO_UPDATE_GITHUB_REPO para o repositório de releases.");
  process.exit(1);
}
if (!token) {
  console.error("Publicação bloqueada: GH_TOKEN (ou GITHUB_TOKEN) precisa ter permissão de escrita em Releases.");
  process.exit(1);
}
if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
  console.error("Publicação bloqueada: owner/repo do GitHub inválidos.");
  process.exit(1);
}
