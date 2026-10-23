<img src="public/favicon.svg" width="64" height="64" alt="">

# melhore seu livro em pdf

Transforma PDFs escaneados de livros em PDFs fáceis de ler no celular.

🔗 No ar: https://dandesdev.github.io/melhoreseulivroempdf/

## O que faz

- Gira páginas escaneadas de lado
- Divide páginas duplas (livro aberto) em duas
- Endireita cada página
- Corta as margens, sombras e bordas do scanner
- Realça o contraste, ou converte para preto e branco
- Coloca as páginas na ordem: livro, mangá/árabe ou livreto
- Permite mover, girar ou excluir páginas antes de baixar

Tudo roda no navegador. O arquivo nunca sai do aparelho.

## Como funciona

Sem modelos de IA: só processamento de imagem clássico, em `src/lib/scan.ts`.

- **Orientação.** Linhas de texto formam faixas. O perfil de tinta varia muito no sentido perpendicular às linhas e pouco no sentido delas. Para saber se está de cabeça para baixo, compara a tinta acima da altura-x (ascendentes, maiúsculas, acentos) com a tinta abaixo (descendentes).
- **Divisão.** Procura no meio da folha a coluna com menos transições tinta/papel. Texto tem muitas; a lombada, mesmo com sombra, quase nenhuma.
- **Alinhamento.** Gira os pixels de tinta em ângulos pequenos e escolhe o ângulo em que a projeção horizontal fica mais nítida.
- **Recorte.** Acha o retângulo da grade de blocos com mais texto e menos espaço vazio, e acrescenta cabeçalhos, títulos e números de página próximos.
- **Contraste.** Estima a cor do papel em cada região, divide a imagem por ela e estica os níveis.

Páginas que não dão para decidir sozinhas (capas, páginas em branco) usam a orientação e a divisão das outras páginas do mesmo arquivo.

## Stack

Vite + React + TypeScript + Tailwind, [pdf.js](https://mozilla.github.io/pdf.js/) para ler e [pdf-lib](https://pdf-lib.js.org/) para gerar o PDF. O processamento roda num Web Worker.

```sh
npm install
npm run dev
```
