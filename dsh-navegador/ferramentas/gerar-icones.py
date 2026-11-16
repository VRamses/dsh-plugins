"""Gera os icones da extensao dsh-navegador.

Desenho: quadrado arredondado em azul DSH, um balao de conversa branco e, dentro
dele, tres barras curtas (o texto) com uma seta pequena no canto (a acao na aba).
Simples de proposito: e um icone de 16 px na maior parte do tempo.
"""

from pathlib import Path
from PIL import Image, ImageDraw

SAIDA = Path(__file__).resolve().parent.parent / "extensoes" / "icones"
SAIDA = Path(r"C:\Users\victo\Documents\DSH\dsh-navegador\extensao\icones")

AZUL = (30, 64, 175, 255)
AZUL_CLARO = (59, 130, 246, 255)
BRANCO = (255, 255, 255, 255)


def desenhar(lado: int) -> Image.Image:
    escala = 8
    n = lado * escala
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    raio = int(n * 0.22)
    d.rounded_rectangle((0, 0, n - 1, n - 1), radius=raio, fill=AZUL)

    # balao de conversa
    bx0, by0 = int(n * 0.17), int(n * 0.19)
    bx1, by1 = int(n * 0.83), int(n * 0.67)
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=int(n * 0.11), fill=BRANCO)
    # rabicho
    d.polygon(
        [
            (int(n * 0.30), by1 - int(n * 0.03)),
            (int(n * 0.28), int(n * 0.80)),
            (int(n * 0.46), by1 - int(n * 0.02)),
        ],
        fill=BRANCO,
    )

    # barras de texto
    barra_h = int(n * 0.055)
    for i, largura in enumerate((0.46, 0.38, 0.24)):
        x0 = bx0 + int(n * 0.10)
        y = by0 + int(n * 0.13) + i * int(n * 0.115)
        d.rounded_rectangle((x0, y, x0 + int(n * largura), y + barra_h), radius=barra_h // 2, fill=AZUL_CLARO)

    return img.resize((lado, lado), Image.LANCZOS)


def main() -> None:
    SAIDA.mkdir(parents=True, exist_ok=True)
    for lado in (16, 32, 48, 128):
        alvo = SAIDA / f"icone-{lado}.png"
        desenhar(lado).save(alvo, "PNG", optimize=True)
        print(f"{alvo.name}: {alvo.stat().st_size} bytes")


if __name__ == "__main__":
    main()
