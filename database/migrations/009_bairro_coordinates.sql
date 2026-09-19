-- ================================================================
-- Acessphones ERP - Migration 009 - Mapa de origem de clientes
-- Cache de coordenadas geográficas por bairro/cidade/estado
-- ================================================================

BEGIN;

-- ================================================================
-- TABELA: bairro_coordinates
-- Cache de geocodificação (Nominatim/OpenStreetMap) por bairro único.
-- Evita chamar a API de geocodificação repetidamente — cada combinação
-- bairro+cidade+estado é resolvida uma única vez e reutilizada sempre.
-- ================================================================
CREATE TABLE IF NOT EXISTS bairro_coordinates (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  neighborhood    VARCHAR(150)  NOT NULL,
  city            VARCHAR(100)  NOT NULL,
  state           VARCHAR(2)    NOT NULL,
  latitude        NUMERIC(10,7),
  longitude       NUMERIC(10,7),
  geocode_failed  BOOLEAN       NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (neighborhood, city, state)
);

CREATE INDEX IF NOT EXISTS idx_bairro_coordinates_lookup
  ON bairro_coordinates (neighborhood, city, state);

-- Reaproveita a função de trigger já criada na migration 001
CREATE TRIGGER set_updated_at_bairro_coordinates
  BEFORE UPDATE ON bairro_coordinates
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
