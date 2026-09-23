-- Reversa del análisis de mercado (historial de precios + vocabulario de tipo).
--
-- Deshace exactamente lo que agregan las dos secciones nuevas de schema.sql:
-- "vocabulario de tipo (análisis)" e "historial de precio y vigencia". No toca
-- ninguna columna ni tabla anterior.
--
--   docker compose cp rollback-analisis.sql db:/tmp/
--   docker compose exec -T db psql -U officelab -d officelab -f /tmp/rollback-analisis.sql
--
-- ⚠️ DESTRUCTIVO: `precio_historial` es la única copia de la serie de precios y
-- no se puede reconstruir — `listings` sólo guarda la foto de hoy. Si la reversa
-- es por un problema del motor de comparables y no del historial, corre nada más
-- la primera mitad y deja la tabla en pie: no le estorba a nadie.

-- ── vocabulario de tipo ──────────────────────────────────────────────────────
-- El índice se va solo con la columna, pero se nombra para que quede escrito.
DROP INDEX IF EXISTS listings_tipo_idx;
ALTER TABLE listings DROP COLUMN IF EXISTS tipo;
DROP FUNCTION IF EXISTS tipo_norm(text);

-- ── historial ────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS listings_historial_cambio ON listings;
DROP TRIGGER IF EXISTS listings_historial_alta   ON listings;
DROP FUNCTION IF EXISTS sincronizar_historial();
DROP FUNCTION IF EXISTS sembrar_historial();   -- retirada el 2026-09-21; por si queda en una base vieja
DROP FUNCTION IF EXISTS registrar_historial();
DROP TABLE IF EXISTS precio_historial;

-- Y en scrapers/propdb.py hay que quitar los dos `SET session_replication_role`
-- y la entrada `sincronizar_historial` del post-proceso, o la carga fallará
-- buscando una función que ya no existe.
