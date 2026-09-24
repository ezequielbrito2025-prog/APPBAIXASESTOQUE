# Servidor de baixa de estoque (ME) e relatório diário

Servidor que guarda as Movimentações de Estoque (ME), registra a baixa com as três assinaturas e, todos os dias no horário configurado (padrão 18:00, fuso America/Fortaleza), envia por e-mail uma planilha Excel e CSV com tudo que foi movimentado.

O servidor também entrega o **aplicativo de celular** (PWA) em `/app/`: leitura de QR Code pela câmera, quantidade por item, assinatura na tela e modo offline com fila de envio. Não há nada para instalar no celular: abre-se o endereço no navegador e, se quiser, "Adicionar à tela inicial".

Além disso, entrega o **painel de conferência** em `/painel/`: uma tela de escritório (não precisa ser mobile) para conferir o que saiu no dia, importar a lista "código do produto → nome" usada para mostrar o nome na hora da leitura do QR, e gerar o PDF de uma ME com os dados e as assinaturas já coletadas. Veja a seção [Painel de conferência](#painel-de-conferência-painel).

## O que já funciona

- Cadastro de MEs com cabeçalho e itens, vindas do painel de Reposição de Estoque ou de qualquer sistema (`POST /movimentacoes`).
- Baixa com quantidade atendida por item e assinaturas de Requisitante, Aprovador e Recebedor, com hash de integridade (`POST /movimentacoes/:numero/atendimento`). Reenviar a mesma baixa é seguro (idempotente por `evento_id`).
- Status da ME: Pendente, Atendido, Atendido parcial e Cancelado. Quantidade acima da solicitada exige justificativa.
- Fechamento diário automático: planilha `.xlsx` (com aba Resumo) e `.csv`, e-mail para a lista de destinatários, assunto "Relatório Diário de Movimentação de Estoque - DD/MM/AAAA".
- Se o envio falhar, tenta de novo (5 vezes, a cada 10 minutos) e registra o erro. Se o servidor estiver desligado às 18:00, envia assim que voltar, no mesmo dia.
- Baixa sincronizada depois do fechamento entra no relatório do dia seguinte, então nada fica de fora.
- Reenvio manual de qualquer dia, download da planilha pela API, trilha de auditoria.

- Aplicativo de celular em `/app/` (PWA): lê o QR da ME (`me://0001` ou só o número) e dos itens (`item://REFERENCIA` ou só a referência), aceita leitor de código de barras/QR bluetooth e digitação, coleta as 3 assinaturas e guarda tudo no aparelho quando está sem internet, enviando sozinho quando a conexão volta.
- Painel de conferência em `/painel/`: importa uma planilha de produtos (Excel/CSV), mostra o que foi baixado num dia (código, nome, quantidade, quem liberou, ativo fixo), baixa a planilha do dia e gera o PDF de uma ME com as assinaturas coletadas.

Testado com 11 testes automáticos contra PostgreSQL 16 e com uma execução completa enviando o e-mail por SMTP. O painel de conferência foi testado num navegador de ponta a ponta (importar planilha, conferir um dia, fechar e baixar a planilha, gerar o PDF de uma ME). O `Dockerfile` e o `docker-compose.yml` ainda não foram testados.

## Rodar no seu computador

Precisa de Node 20.12 ou mais novo e de um PostgreSQL. O jeito mais fácil é o Docker:

```bash
cp .env.example .env        # edite API_TOKEN (e o SMTP, se quiser e-mail de verdade)
docker compose up --build   # sobe banco + API em http://localhost:3000
```

Sem Docker:

```bash
npm install
cp .env.example .env        # ajuste DATABASE_URL e API_TOKEN
npm run migrate             # cria as tabelas
npm run seed                # opcional: cria a ME 0001 de exemplo e cadastra destinatários
                            #   SEED_EMAILS="gerencia@x.com,almox@x.com" npm run seed
npm start
npm test                    # precisa do banco de teste (TEST_DATABASE_URL); apaga o conteúdo dele
```

Sem `SMTP_HOST`, o e-mail não sai: o servidor grava o e-mail e os anexos na pasta `out/`. Serve para conferir o relatório antes de ligar o envio real.

## Testando à mão

Todas as rotas (menos `/health`) pedem `Authorization: Bearer <API_TOKEN>`.

```bash
H="Authorization: Bearer $API_TOKEN"; J="content-type: application/json"

# 1. cadastrar destinatários do relatório
curl -X POST localhost:3000/destinatarios -H "$H" -H "$J" -d '{"email":"gerencia@empresa.com","grupo":"Gerência"}'

# 2. criar uma ME (o painel de Reposição faria isto)
curl -X POST localhost:3000/movimentacoes -H "$H" -H "$J" -d '{
  "tipo":"SAIDA","data_me":"2026-09-21","local_aplicacao":"Estoque Dois Irmãos",
  "itens":[{"referencia":"OS0027V","nome_material":"PNEU CONSERT 275/80R22.5","unidade":"PC",
            "qtd_solicitada":35,"custo_unitario":173.59,"localizacao":"GAIOLA"}]}'

# 3. registrar a baixa com as três assinaturas (o app faria isto)
curl -X POST localhost:3000/movimentacoes/0001/atendimento -H "$H" -H "$J" -d '{
  "evento_id":"um-id-unico-por-baixa","itens":[{"item_seq":1,"qtd_atendida":35}],
  "assinaturas":[
    {"papel":"REQUISITANTE","nome":"Ana Souza","tracado_svg":"M0 0 L9 9"},
    {"papel":"APROVADOR","nome":"Bruno Lima","tracado_svg":"M0 0 L9 9"},
    {"papel":"RECEBEDOR","nome":"Carla Dias","tracado_svg":"M0 0 L9 9"}]}'

# 4. rodar o fechamento na hora (normalmente o agendador faz isto às 18:00)
curl -X POST localhost:3000/fechamentos/2026-09-21/executar -H "$H"
curl -OJ "localhost:3000/fechamentos/2026-09-21/arquivo?formato=xlsx" -H "$H"
```

## Rotas

| Rota | Para que serve |
| --- | --- |
| `GET /app/` | O aplicativo de celular (sem token; o app pede o código de acesso) |
| `GET /painel/` | O painel de conferência (sem token; o painel pede o código de acesso) |
| `GET /health` | Verifica se está no ar (sem token) |
| `POST /movimentacoes` | Cria a ME com itens. `numero_me` opcional; sem ele, o servidor gera 0001, 0002... |
| `GET /movimentacoes/:numero` | ME completa: cabeçalho, itens e assinaturas |
| `GET /movimentacoes?status=&data_me=` | Lista de MEs |
| `GET /movimentacoes/conferencia?data=` | Linhas baixadas num dia, uma por item (uso do painel) |
| `GET /sync/pull` | MEs pendentes para o app guardar no aparelho (uso do app) |
| `POST /movimentacoes/:numero/atendimento` | Baixa + assinaturas |
| `POST /movimentacoes/:numero/cancelar` | Cancela ME pendente (`{"motivo":"..."}`) |
| `GET /movimentacoes/:numero/assinaturas/:papel` | Imagem da assinatura |
| `GET/PUT /configuracao` | `horario_fechamento` (HH:MM), `fuso`, `remetente_nome` |
| `GET/POST/DELETE /destinatarios` | Lista de e-mails do relatório |
| `GET /fechamentos` | Histórico dos envios e erros |
| `GET /fechamentos/:data/arquivo?formato=xlsx\|csv` | Baixa a planilha de um dia |
| `POST /fechamentos/:data/executar` | Roda o fechamento de uma data agora |
| `POST /fechamentos/:data/reenviar` | Envia de novo um dia já enviado |

## Colocar no ar

1. **Banco:** crie um PostgreSQL (Railway, Render, Supabase, Neon ou o da sua TI) e copie a URL de conexão.
2. **Servidor:** publique esta pasta como um serviço Node (há `Dockerfile`; nos serviços acima basta apontar para o repositório). Comando de início: `npm start`. As tabelas são criadas sozinhas na primeira subida.
3. **Variáveis de ambiente:** `API_TOKEN`, `DATABASE_URL`, `MAIL_FROM`, `SMTP_*` (veja `.env.example`). Mantenha o serviço ligado o tempo todo: o agendador roda dentro dele.
4. **E-mail:** use o SMTP que você já tem. Microsoft 365: `smtp.office365.com`, porta 587, exige SMTP autenticado habilitado na conta. Gmail/Workspace: `smtp.gmail.com`, porta 587, com senha de app. Serviços como Resend, SendGrid ou Amazon SES também servem, cada um com seu host e credencial SMTP.
5. **Destinatários e horário:** cadastre com `POST /destinatarios` e, se quiser outro horário, `PUT /configuracao`.
6. **Teste:** `POST /fechamentos/<hoje>/executar` e confira o e-mail antes de deixar o agendador cuidar disso.

Use sempre HTTPS (os serviços acima já entregam). **A câmera do celular só funciona em HTTPS** (ou em `localhost`); sem isso o app ainda funciona com leitor externo ou digitação, mas não abre a câmera e guarde o `API_TOKEN` como segredo. Não rode em duas instâncias sem necessidade; se rodar, o fechamento usa um bloqueio no banco para não enviar em duplicidade.

## Painel de conferência (`/painel/`)

Uma tela de escritório (funciona em qualquer navegador, não precisa ser no celular) com três abas:

- **Conferência:** escolha uma data e veja, linha por linha, o que foi baixado naquele dia — código, nome do produto, quantidade, quem liberou (o Requisitante que assinou) e o ativo fixo da ME. O botão "Baixar planilha do dia" baixa o mesmo relatório enviado por e-mail às 18:00; se o fechamento daquele dia ainda não aconteceu, o painel avisa e oferece um botão para fechar na hora (isso também dispara o e-mail).
- **Produtos:** importa uma planilha (Excel ou CSV) com o código do produto — o mesmo que está no QR Code da etiqueta — e o nome dele. Essa lista fica **só neste computador** (no armazenamento local do navegador, não vai para o servidor) e é usada para mostrar o nome do produto nas telas de conferência e no PDF sempre que o código bater. Se a planilha importada não tiver um produto, o painel mostra o nome que veio com a ME.
- **PDF da ME:** digite o número de uma ME (ou escolha numa lista das MEs recentes) para gerar um PDF com o cabeçalho, os itens e as três assinaturas já coletadas (Requisitante, Aprovador, Recebedor). O que ainda não foi assinado aparece como "Aguardando assinatura".

O painel usa o mesmo código de acesso (`API_TOKEN`) do app de celular — ele pede esse código na primeira vez e guarda no navegador. Como o catálogo de produtos é local, se você importar a planilha num computador, ela não aparece em outro: importe em cada computador que for usar o painel. Se limpar os dados do navegador (ou usar o modo anônimo), o catálogo importado se perde — o botão "Exportar catálogo (.csv)" serve para guardar uma cópia de segurança fora do navegador.

## Pontos a decidir com a Controladoria

- **Coluna Data da planilha:** hoje mostra a data em que a baixa foi registrada (não a data impressa na ME).
- **Corte do dia:** entram as baixas registradas até o momento do fechamento. Baixas feitas depois das 18:00 entram no relatório do dia seguinte.
- **Custo:** a planilha usa o custo unitário congelado na ME, com 4 casas, e arredonda o total de cada linha em 2 casas.

## O que falta (próximas fases)

- Login por usuário e perfil (hoje há um token único de sistema, tanto no app quanto no painel).
- Geração de etiquetas com QR Code.
- Teste do app e do painel em aparelhos e navegadores reais (a câmera do app não pôde ser testada fora de um celular; o restante do fluxo — incluindo o painel — foi testado em navegador, inclusive offline no app).
- Integração de mão dupla com o ERP (saldo por item).
- Catálogo de produtos centralizado no servidor (hoje é importado por computador, no painel).

## Créditos

A leitura de QR Code pela câmera usa a biblioteca [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0), incluída em `public/vendor/jsQR.js`, quando o navegador não tem leitor nativo (`BarcodeDetector`).

O painel de conferência usa [SheetJS/xlsx](https://sheetjs.com) (Apache-2.0) para ler a planilha de produtos e [jsPDF](https://github.com/parallax/jsPDF) (MIT) para montar o PDF da ME, ambas incluídas em `public/painel/vendor/`.
