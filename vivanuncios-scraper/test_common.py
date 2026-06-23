"""Auto-check mínimo: parseo de precio. Corre: python test_common.py"""
from common import clean_price, posting_id


def demo():
    assert clean_price("MN 2,500,000") == ("MXN", 2500000.0)
    assert clean_price("USD 150,000") == ("USD", 150000.0)
    assert clean_price("$ 1,250,500 MXN") == ("MXN", 1250500.0)
    assert clean_price("Consultar precio") == ("MXN", None)
    assert clean_price("") == (None, None)
    print("OK clean_price")

    assert posting_id("https://www.vivanuncios.com.mx/a-casa/mty-casa-12345678.html") == "12345678"
    assert posting_id("https://www.vivanuncios.com.mx/anuncio/87654321") == "87654321"
    assert posting_id("https://www.vivanuncios.com.mx/sin-id") is None
    print("OK posting_id")


if __name__ == "__main__":
    demo()
