Uma execução é uma otimização. Ela tem um status, um limite de gastos e um conjunto de versões salvas. Esta página explica os estados de uma execução, as ações que você pode realizar nela e os motivos pelos quais uma execução para.

## Estados da execução

Toda execução tem um destes status:

| Status       | Significado                                                                  |
| ------------ | ---------------------------------------------------------------------------- |
| `pending`    | A execução está na fila.                                                     |
| `validating` | O Skynet verifica a configuração antes de a otimização começar.              |
| `running`    | O otimizador propõe e pontua novas versões.                                  |
| `success`    | A execução terminou. A melhor versão está salva.                             |
| `failed`     | Um erro interrompeu a execução.                                              |
| `cancelled`  | Uma pessoa cancelou a execução.                                              |
| `paused`     | A execução parou em um checkpoint. Você pode retomá-la.                      |
| `stopped`    | A execução parou no limite do orçamento. Ela mantém a melhor versão que encontrou. |

`success`, `failed`, `cancelled`, `stopped` e `paused` são estados terminais. O otimizador não trabalha em uma execução em estado terminal. `paused` é o único estado terminal que existe para ser retomado.

## Ações

A página da execução mostra as ações que se aplicam ao status atual e à sua função. A API tem as mesmas ações.

| Ação         | Quando você pode usá-la                                                                                          | O que faz                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Pausar**   | A execução está em andamento e tem um checkpoint salvo.                                                          | Para a execução no checkpoint. O status muda para `paused`.                   |
| **Cancelar** | A execução está `pending`, `validating` ou `running`.                                                            | Para a execução. Não é possível desfazer um cancelamento.                     |
| **Retomar**  | A execução está `failed`, `cancelled`, `paused` ou `stopped` no limite do orçamento, e tem um checkpoint salvo.  | Continua a mesma execução a partir do último checkpoint. A execução mantém o seu id. |
| **Clonar**   | Sempre que você puder ver a execução.                                                                            | Abre o assistente de envio com uma cópia da configuração.                     |
| **Eliminar** | A execução está em um estado terminal. Apenas o proprietário.                                                    | Exclui permanentemente a execução e todos os dados dela.                      |

A API também tem mais duas ações para uma execução `failed` ou `cancelled`:

- **Tentar novamente** inicia uma nova execução com a mesma configuração. A nova execução recebe um novo id.
- **Reiniciar** inicia a mesma execução de novo, desde o começo. A execução mantém o seu id.

> [!NOTE]
> Tentar novamente, reiniciar e clonar pela API recusam uma execução que tem o seu próprio limite de gastos. Abra a configuração no assistente de envio e defina um novo orçamento antes de iniciar uma nova execução. O botão **Clonar** na página da execução faz isso por você.

A clonagem pela API pode criar de 1 a 5 cópias em uma requisição. Cada cópia conta para os seus limites de execuções. Veja [Limites](/docs/limits).

### Quem pode realizar uma ação

A sua função na execução controla as ações que você vê:

- Um **proprietário** pode realizar todas as ações, gerenciar o compartilhamento e excluir a execução.
- Um **editor** pode pausar, cancelar, retomar e tentar novamente a execução, e aumentar o limite de gastos dela.
- Um **visualizador** pode abrir a execução e cloná-la.

Leia [Compartilhar e publicar](/docs/guides/sharing) para saber mais sobre as funções.

## Como uma execução para

Uma execução para por um de quatro motivos.

### Conclusão

O otimizador termina o seu trabalho. O status muda para `success`. O Skynet salva a melhor versão e executa o teste final. Leia [Ler os resultados](/docs/guides/results).

### Orçamento

Uma execução não tem uma estimativa de custo antes de começar. O limite de gastos é o orçamento que ela pode usar. O Skynet mede o custo real de cada execução do avaliador à medida que a execução avança:

1. O Skynet espera 10 execuções do avaliador liquidadas. Antes disso, o custo de uma chamada é variável demais para ser usado.
2. O Skynet usa o custo médio até o momento para precificar a próxima iteração. Ele multiplica o preço por 1,5, porque as iterações posteriores costumam custar mais.
3. Quando o orçamento restante não consegue pagar a próxima iteração, o Skynet para de admitir novo trabalho. O otimizador para na próxima chamada paga.

A execução então fica com o status `stopped` e o motivo de parada `budget_reached`. A página da execução mostra um aviso **Orçamento atingido**. O aviso informa qual versão o Skynet salvou:

- A sua melhor versão avaliada.
- A sua versão inicial avaliada, se nenhuma versão melhor foi encontrada.
- Nenhuma versão, se o orçamento acabou antes de algum candidato terminar a avaliação. As suas entradas e os seus logs continuam salvos.

Para continuar, use **Aumentar o limite e continuar** no aviso. O Skynet retoma a execução a partir do último checkpoint.

> [!TIP]
> Uma execução com **Sem limite** usa o saldo da sua conta até terminar. Se o saldo acabar, a execução para e mantém o que já tem. O aviso então diz **Saldo da conta esgotado**. Adicione fundos e depois retome a execução.

Algumas execuções mais antigas foram pausadas com o motivo de parada `budget_projected`. Você pode retomá-las da mesma forma.

### Falha

Um erro interrompe a execução. O status muda para `failed`. A aba **Registos** mostra o que aconteceu. Se a execução tiver um checkpoint salvo, você pode retomá-la. Você também pode tentar novamente.

Se um worker parar enquanto executa o seu job, o Skynet recupera o job e tenta de novo. Depois de 3 tentativas, o Skynet marca o job como falho. Retomar após uma falha ou um cancelamento também conta como uma tentativa. Retomar após uma pausa ou uma parada por orçamento não conta.

### Cancelamento

Você cancela a execução. O status muda para `cancelled`. Não é possível desfazer um cancelamento. Mais tarde, você pode retomar a execução a partir de um checkpoint salvo ou tentar novamente.

## Páginas relacionadas

- [Orçamentos e cobrança](/docs/concepts/billing)
- [Iniciar uma execução com o assistente](/docs/guides/submit)
- [Limites](/docs/limits)
