O rotulador adiciona rótulos às linhas de um conjunto de dados. Você pode rotular cada linha você mesmo, ou deixar um modelo de IA rotular as linhas enquanto você revisa o trabalho dele. O resultado é um conjunto de dados rotulado que você pode usar em uma execução.

## Iniciar uma sessão

Abra o rotulador de uma destas formas:

- Abra o rotulador a partir do painel principal.
- Em **Conjuntos de dados**, selecione um conjunto de dados e clique em **Marcar este conjunto de dados**.
- No editor de conjuntos de dados, clique em **Etiquetar com IA**.

### Escolher os dados

A configuração pede os dados a rotular:

- **Escolher da sua biblioteca** usa um conjunto de dados que você enviou. Para enviar um novo arquivo, use primeiro [Conjuntos de dados](/docs/guides/datasets).
- **Gerar um conjunto de dados sintético** cria linhas para você. Esta opção precisa do assistente.

### Escolher o tipo de tarefa

| Tipo de tarefa                   | O que você dá a cada linha                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| **Pergunta de Sim / Não**        | Uma resposta sim ou não.                                                                |
| **Escolher entre categorias**    | Uma ou mais categorias de uma lista que você define. Adicione pelo menos duas categorias. |
| **Respostas escritas**           | Uma resposta em texto livre.                                                            |

### Escolher um modo

A configuração pergunta "Como quer etiquetar?". Há três modos:

| Modo                    | O que acontece                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Manual**              | Você rotula cada linha você mesmo. Nenhuma IA participa.                                                    |
| **Co-piloto** (Co-pilot) | Após uma breve entrevista, a IA marca um primeiro lote. Você mantém ou corrige cada rótulo em rodadas de revisão. |
| **Piloto automático** (Autopilot) | Após uma breve entrevista, a IA marca todas as linhas e sinaliza as linhas sobre as quais tem dúvida.       |

A configuração marca um modo como **Recomendado**.

A configuração também tem uma escolha de **Modelo de marcação**. O padrão serve para a maioria dos conjuntos de dados.

> [!NOTE]
> No app para Mac, marcar com IA precisa da sua própria chave de provedor. Escolha um modelo em **A sua própria chave**. Veja [App para Mac](/docs/guides/mac-app).

## A entrevista sobre o conjunto de dados

Os modos Co-piloto e Piloto automático começam com uma **Entrevista sobre o conjunto de dados**. A IA faz perguntas sobre os seus dados e os seus rótulos. Você pode clicar em **Pular a entrevista**.

A entrevista cria um **Guia de marcação**. O guia contém as regras que a IA segue. Use **Adicionar uma regra** para adicionar a sua própria regra.

No final, a IA mostra **Este é o plano**. Depois você inicia o trabalho:

- No Co-piloto, clique em **Marcar as primeiras {rows} linhas para a minha revisão**.
- No Piloto automático, clique em **Marcar todas as {rows} linhas**.

## Rodadas de revisão do Co-piloto

No Co-piloto, a IA primeiro marca um lote de calibração. O tamanho do lote depende do tipo de tarefa:

| Tipo de tarefa             | Primeiro lote                                              |
| -------------------------- | ---------------------------------------------------------- |
| Pergunta de Sim / Não      | 24 linhas                                                  |
| Escolher entre categorias  | 6 linhas para cada categoria, no mínimo 30 e no máximo 60  |
| Respostas escritas         | 30 linhas                                                  |

Se o conjunto de dados tiver menos linhas, a IA marca todas.

### Revisar cada rótulo

Para cada linha, o painel lateral mostra o rótulo da IA:

1. Leia a linha e o rótulo.
2. Para manter o rótulo, clique em **Confirmar (Enter)** ou pressione Enter.
3. Para alterar o rótulo, corrija-o. O painel mostra "Corrigido — a IA vai aprender com isso".
4. Quando terminar, clique em **Concluir esta rodada**.

O painel mostra a meta: "Assim que concordarmos {gate}% das vezes, etiqueto sozinho o resto."

### O limite de concordância

Após cada rodada, o Skynet mede com que frequência você concordou com a IA. O limite é de 92% para tarefas de Sim / Não e de categorias. É de 85% para respostas escritas.

O resumo da rodada mostra "Você concordou com a IA em {agreement}%". Depois você escolhe:

- **Mais uma rodada de revisão** dá a você outro lote para revisar.
- **Marcar as {rows} linhas restantes** deixa a IA marcar o resto.

## Piloto automático e marcação automática

Quando a IA marca as linhas restantes, o trabalho roda no servidor. Você pode sair da página com segurança e voltar depois.

- **Retomar marcação** continua um job interrompido.
- **Cancelar — manter o que já foi marcado** para o job e mantém os rótulos que já existem.

### Revisar as linhas com dúvida

A IA dá a cada rótulo automático um nível de confiança. O Skynet sinaliza uma linha quando a confiança está abaixo de 0,75. Depois do job, clique em **Revise {count} linhas sobre as quais a IA ficou em dúvida** para conferi-las.

> [!TIP]
> Revise as linhas sinalizadas antes de usar os dados em uma execução. Rótulos errados reduzem a qualidade da otimização.

## Modo manual

No modo Manual, você rotula cada linha você mesmo. Os atalhos de teclado abaixo ajudam você a trabalhar rápido.

### Atalhos de teclado

| Tecla              | Ação                                                     |
| ------------------ | -------------------------------------------------------- |
| Ctrl+H ou Cmd+H    | Mostrar os atalhos.                                      |
| Y / N              | Responder sim ou não em uma linha de Sim / Não.          |
| 1 a 9              | Selecionar ou limpar essa categoria em uma linha de categorias. |
| U                  | Ir para a próxima linha sem rótulo.                      |
| Home               | Ir para a primeira linha.                                |
| E                  | Exportar como CSV.                                       |

## Resultados

Os resultados mostram de onde veio cada rótulo:

| Contagem                                   | Significado                                   |
| ------------------------------------------ | --------------------------------------------- |
| **Etiquetado por si**                      | Rótulos que você escreveu.                    |
| **Etiquetas de IA confirmadas por si**     | Rótulos da IA que você manteve na revisão.    |
| **Etiquetado automaticamente**             | Rótulos da IA sem revisão.                    |
| **Custo**                                  | O custo do trabalho da IA nesta sessão.       |

A coluna **Origem** mostra os mesmos valores para cada linha: **Você**, **IA confirmado** ou **IA**.

## Salvar e exportar

### Salvar na biblioteca

Clique em **Guardar na biblioteca** ou **Mover para Conjuntos de dados** para manter os dados rotulados como um conjunto de dados. Depois você pode usá-lo em uma [execução](/docs/guides/submit).

### Exportar um arquivo

Clique em **Exportar etiquetas** e escolha um formato:

- CSV
- JSON
- Excel (`.xlsx`)
- Parquet
- Feather

Se algumas linhas não tiverem rótulo, o Skynet pede que você confirme a exportação.

A exportação adiciona uma coluna de rótulo. O nome dela depende do tipo de tarefa:

| Tipo de tarefa             | Coluna                |
| -------------------------- | --------------------- |
| Pergunta de Sim / Não      | `binary_label`        |
| Escolher entre categorias  | `selected_categories` |
| Respostas escritas         | `extracted_text`      |

Uma coluna `label_source` registra de onde veio cada rótulo.

## Sessões

Cada trabalho de marcação é uma sessão. Uma sessão tem um destes status: **Em curso**, **Em revisão**, **Marcação automática** ou **Concluído**. Clique em **Iniciar nova sessão** para recomeçar com novas configurações.

Você pode compartilhar uma sessão com outras pessoas pela caixa de diálogo de compartilhamento dela. Para as regras de compartilhamento, veja [Compartilhar e publicar](/docs/guides/sharing).

## Próximos passos

- [Prepare um conjunto de dados](/docs/guides/datasets) antes de marcar.
- [Inicie uma execução](/docs/guides/submit) com os dados rotulados.
- Pergunte ao [painel do agente](/docs/guides/agent-panel) sobre as suas sessões de marcação.
