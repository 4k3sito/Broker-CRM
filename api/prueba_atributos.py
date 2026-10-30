"""Pruebas de `atributos.py` (`npm run probar:api`). No usan la base: `api/probar.sh` corre
cada `prueba_*.py` y a ésta le basta con el módulo. Cada caso salió de un anuncio real.
"""
from __future__ import annotations

import sys

import atributos


def v(tipo, features=None, texto=None) -> dict:
    return {a["clave"]: a["valor"] for a in atributos.de(tipo, features, texto)}


def cada_tipo_ensena_lo_suyo():
    fs = ["Estacionamientos: 4", "Baños: 2", "Elevador"]
    assert [a["clave"] for a in atributos.de("oficina", fs, None)] == ["cajones", "banos", "elevador"]
    assert [a["clave"] for a in atributos.de("local", fs, "8 m de frente")] == ["frente", "banos", "cajones"]
    assert [a["clave"] for a in atributos.de("bodega", fs, "altura de 10 metros")] == ["altura", "cajones"]
    assert atributos.de("terreno", fs, None) == []          # un terreno no tiene baños
    assert [a["clave"] for a in atributos.de(None, fs, None)] == ["cajones", "banos"]


def sin_dato_no_sale_nada():
    assert atributos.de("bodega", None, None) == []
    assert atributos.de("local", [], "") == []


def lo_que_dice_el_portal_gana_a_la_descripcion():
    assert v("bodega", ["estacionamientos: 4"], "12 cajones") == {"cajones": 4}
    assert v("bodega", None, "cuenta con 12 cajones de estacionamiento") == {"cajones": 12}
    assert v("bodega", None, "cinco (5) estacionamientos") == {"cajones": 5}


def estacionamiento_sin_numero_es_que_si_hay():
    assert v("bodega", ["estacionamiento"]) == {"cajones": True}
    assert v("local", ["estacionamiento techado"]) == {"cajones": True}
    assert v("local", ["facilidad para estacionarse"]) == {}
    assert v("local", None, "un estacionamiento amplio") == {}


def cada_medio_bano_cuenta_como_bano():
    assert v("local", ["baños: 2", "medios baños: 1"]) == {"banos": 3}
    assert v("local", ["2 medios baños"]) == {"banos": 2}
    assert v("local", None, "2 baños completos y 1 medio baño") == {"banos": 3}
    assert v("local", None, "2.5 baños") == {"banos": 3}
    assert v("local", None, "1 1/2 baño y 1 lugar") == {"banos": 2}
    assert v("local", None, "cuenta con 1/2 baño") == {}
    assert v("oficina", None, "nivel: 3 baños: 8 cajones: 4").get("banos") is None


def la_altura_es_una_medida_no_un_lugar():
    assert v("bodega", None, "ALTURA LIBRE INTERIOR DE BODEGA 9M") == {"altura": 9}
    assert v("bodega", None, "Altura total: 12.43m") == {"altura": 12.43}
    assert v("bodega", None, "nave de 9 metros de altura") == {"altura": 9}
    assert v("bodega", None, "a la altura de Gonzalitos, a 500 m del metro") == {}
    assert v("bodega", None, "altura 1200 m2") == {}        # es superficie
    assert v("bodega", None, "altura de 200 m") == {}       # fuera de rango
    assert v("bodega", None, "altura minima 9. 14 mts") == {"altura": 9.14}
    assert v("terreno", None, "2.\n24 m de frente") == {"frente": 24}    # un salto de línea no parte un decimal
    assert v("bodega", None, "claro entre columnas de 30 metros") == {}
    assert v("bodega", None, "altura maxima 40 mts de frente x 35 de fondo") == {}
    assert v("bodega", None, "12mts de altura maxima y 9 altura minima 20mts de frente") == {"altura": 12}


def el_frente_es_una_medida_no_una_direccion():
    assert v("terreno", None, "10 m de frente por 30 de fondo") == {"frente": 10}
    assert v("terreno", None, "Frente: 25.5 m") == {"frente": 25.5}
    assert v("terreno", None, "frente de 40 metros") == {"frente": 40}
    assert v("terreno", None, "frente a 200 m del metro") == {}
    assert v("terreno", None, "a 100 metros frente a la plaza") == {}


def el_frente_que_trae_el_portal():
    assert v("local", ["M² de frente: 48", "M² de fondo: 124"]) == {"frente": 48}


def andenes_con_y_sin_numero():
    assert v("bodega", None, "2 andenes de carga") == {"andenes": 2}
    assert v("bodega", None, "cuenta con dos andenes") == {"andenes": 2}
    assert v("bodega", None, "con andén para tráiler") == {"andenes": True}
    assert v("bodega", None, "sin andén") == {}


def elevador_negado_no_cuenta():
    assert v("oficina", ["elevador: 1"]) == {"elevador": True}
    assert v("oficina", None, "edificio con elevador") == {"elevador": True}
    assert v("oficina", None, "sin elevador") == {}


PRUEBAS = [cada_tipo_ensena_lo_suyo, sin_dato_no_sale_nada, lo_que_dice_el_portal_gana_a_la_descripcion,
           estacionamiento_sin_numero_es_que_si_hay, cada_medio_bano_cuenta_como_bano, la_altura_es_una_medida_no_un_lugar,
           el_frente_es_una_medida_no_una_direccion, el_frente_que_trae_el_portal, andenes_con_y_sin_numero, elevador_negado_no_cuenta]


def main() -> int:
    fallas = 0
    for prueba in PRUEBAS:
        try:
            prueba()
            print(f"  ok     {prueba.__name__}")
        except Exception as e:
            fallas += 1
            print(f"  FALLA  {prueba.__name__}: {type(e).__name__}: {e}")
    print(f"atributos: {len(PRUEBAS) - fallas} de {len(PRUEBAS)} pruebas pasan")
    return 1 if fallas else 0


if __name__ == "__main__":
    sys.exit(main())
