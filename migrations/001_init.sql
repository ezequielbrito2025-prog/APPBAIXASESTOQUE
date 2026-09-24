-- Esquema inicial: ME (movimentação de estoque), itens, assinaturas,
-- configuração, destinatários do relatório e fechamento diário.

CREATE SEQUENCE me_numero_seq START 1;

CREATE TABLE item (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referencia             text NOT NULL UNIQUE,
  nome                   text NOT NULL,
  unidade                text NOT NULL,
  custo_unitario_atual   numeric(14,4) NOT NULL DEFAULT 0,
  localizacao            text,
  conta                  text,
  ativo                  boolean NOT NULL DEFAULT true,
  atualizado_em          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fechamento_diario (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_ref           date NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'EM_ANDAMENTO'
                     CHECK (status IN ('EM_ANDAMENTO','ENVIADO','FALHA')),
  iniciado_em        timestamptz NOT NULL DEFAULT now(),
  enviado_em         timestamptz,
  qtd_movimentacoes  int NOT NULL DEFAULT 0,
  qtd_linhas         int NOT NULL DEFAULT 0,
  custo_saidas       numeric(14,2) NOT NULL DEFAULT 0,
  custo_entradas     numeric(14,2) NOT NULL DEFAULT 0,
  arquivo_xlsx       bytea,
  tentativas         int NOT NULL DEFAULT 0,
  proxima_tentativa  timestamptz,
  destinatarios      text,
  erro               text
);

CREATE TABLE movimentacao (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_me                   text NOT NULL UNIQUE,
  tipo                        text NOT NULL CHECK (tipo IN ('SAIDA','ENTRADA')),
  data_me                     date NOT NULL,
  contrato                    text,
  setor                       text,
  frente_servico_equipamento  text,
  ordem_servico               text,
  ativo_fixo                  text,
  local_aplicacao             text,
  status                      text NOT NULL DEFAULT 'PENDENTE'
                              CHECK (status IN ('PENDENTE','EM_ATENDIMENTO','ATENDIDO','ATENDIDO_PARCIAL','CANCELADO')),
  custo_total_estimado        numeric(14,2) NOT NULL DEFAULT 0,
  custo_total_atendido        numeric(14,2),
  origem                      text,
  atendido_por                text,
  atendido_em                 timestamptz,
  evento_atendimento_id       text UNIQUE,
  fechamento_id               uuid REFERENCES fechamento_diario(id),
  criado_em                   timestamptz NOT NULL DEFAULT now(),
  atualizado_em               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX movimentacao_status_idx ON movimentacao (status);
CREATE INDEX movimentacao_fechamento_idx ON movimentacao (fechamento_id);

CREATE TABLE movimentacao_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movimentacao_id   uuid NOT NULL REFERENCES movimentacao(id) ON DELETE CASCADE,
  item_seq          int NOT NULL,
  item_id           uuid REFERENCES item(id),
  referencia        text NOT NULL,
  nome_material     text NOT NULL,
  unidade           text NOT NULL,
  qtd_solicitada    numeric(14,3) NOT NULL CHECK (qtd_solicitada >= 0),
  qtd_atendida      numeric(14,3) CHECK (qtd_atendida >= 0),
  custo_unitario    numeric(14,4) NOT NULL DEFAULT 0,
  custo_total       numeric(14,2),
  localizacao       text,
  conta             text,
  justificativa     text,
  UNIQUE (movimentacao_id, item_seq)
);

CREATE TABLE assinatura (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movimentacao_id   uuid NOT NULL REFERENCES movimentacao(id) ON DELETE CASCADE,
  papel             text NOT NULL CHECK (papel IN ('REQUISITANTE','APROVADOR','RECEBEDOR')),
  nome              text NOT NULL,
  matricula         text,
  tracado_svg       text,
  imagem_png        bytea,
  hash_sha256       text NOT NULL,
  assinado_em       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (movimentacao_id, papel)
);

CREATE TABLE configuracao (
  chave  text PRIMARY KEY,
  valor  text NOT NULL
);
INSERT INTO configuracao (chave, valor) VALUES
  ('horario_fechamento', '18:00'),
  ('fuso', 'America/Fortaleza'),
  ('remetente_nome', 'Controle de Estoque');

CREATE TABLE destinatario_relatorio (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email  text NOT NULL UNIQUE,
  nome   text,
  grupo  text,
  ativo  boolean NOT NULL DEFAULT true
);

-- Trilha de auditoria: o aplicativo só insere, nunca altera nem apaga.
CREATE TABLE auditoria (
  id            bigserial PRIMARY KEY,
  entidade      text NOT NULL,
  entidade_id   text NOT NULL,
  acao          text NOT NULL,
  usuario       text,
  detalhe       jsonb,
  criado_em     timestamptz NOT NULL DEFAULT now()
);
