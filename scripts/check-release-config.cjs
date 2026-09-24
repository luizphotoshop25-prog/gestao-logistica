const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const releaseTargets = require("../electron-builder.config.cjs").publish;
if (releaseTargets.length !== 1 || releaseTargets[0].provider !== "github"
  || releaseTargets[0].owner !== "luizphotoshop25-prog" || releaseTargets[0].repo !== "gestao-logistica") {
  console.error("Publicação bloqueada: provider GitHub não corresponde ao repositório de releases aprovado.");
  process.exit(1);
}
if (!token) {
  console.error("Publicação bloqueada: GH_TOKEN (ou GITHUB_TOKEN) precisa ter permissão de escrita em Releases.");
  process.exit(1);
}
const workflowRepository = process.env.GITHUB_REPOSITORY;
if (workflowRepository && workflowRepository.toLowerCase() !== "luizphotoshop25-prog/gestao-logistica") {
  console.error("Publicação bloqueada: o workflow está executando fora do repositório de releases aprovado.");
  process.exit(1);
}
