from botasaurus.browser import browser, Driver

BASE_URL = (
    "https://www.propiedadesmexico.com/Es/"
    "terrenos+residenciales-terrenos+comerciales-terrenos+industriales"
    "-en-venta-en-monterrey_nuevo_leon"
)
OUTPUT_HTML = "output/propiedades_page1.html"


@browser(headless=True)
def discover(driver: Driver, _=None):
    print(f"[discover] Loading {BASE_URL}")
    driver.get(BASE_URL)
    driver.long_random_sleep()
    driver.scroll_to_bottom()
    driver.long_random_sleep()

    html = driver.page_html
    with open(OUTPUT_HTML, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"[discover] Saved {len(html):,} bytes → {OUTPUT_HTML}")
    return html


if __name__ == "__main__":
    import os
    os.makedirs("output", exist_ok=True)
    discover(None)
    print(f"\nNext: inspect {OUTPUT_HTML} to find card selectors and pagination pattern.")
