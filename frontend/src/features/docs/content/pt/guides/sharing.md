Você pode compartilhar uma execução com outras pessoas e pode listá-la na galeria pública Explorar. São duas configurações diferentes. O acesso por link e os convites controlam quem pode abrir uma execução. A visibilidade pública controla se a execução aparece na pesquisa pública. Este guia explica as duas.

## Padrões

| Configuração                                    | Padrão para uma nova execução                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Visibilidade pública                            | **Pública**. A execução aparece na pesquisa pública.                      |
| Acesso por link                                 | **Restrito**. Apenas o proprietário e as pessoas convidadas podem abrir a execução. |
| Função para **Qualquer pessoa com a ligação**   | **Visualizador**                                                          |

O assistente de envio mostra a visibilidade de uma nova execução na última tela. Você a altera depois que a execução começa, na caixa de diálogo **Partilha e privacidade**.

> [!WARNING]
> Novas execuções são públicas por padrão. Se a sua execução contém dados que outros usuários não podem ver, defina-a como **Privada** na caixa de diálogo **Partilha e privacidade**.

## Abrir as configurações de compartilhamento

Na página da execução, selecione **Partilha e privacidade**. Apenas o proprietário da execução vê esse botão.

## Funções

Cada pessoa que pode abrir uma execução tem uma de três funções:

| Função             | O que a pessoa pode fazer                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Visualizador**   | Abrir a execução e ver os resultados e o proprietário dela. Clonar a execução.                                                |
| **Editor**         | Acesso de visualizador, mais executar o modelo, conversar e renomear. Um editor também pode cancelar, pausar, retomar e tentar novamente a execução. |
| **Proprietário**   | Controle total, incluindo gerenciar o compartilhamento e a exclusão.                                                          |

Uma execução tem exatamente um proprietário. Todas as pessoas que abrem uma execução compartilhada precisam iniciar sessão. Não há acesso anônimo a uma execução compartilhada.

## Compartilhar um link

1. Abra **Partilha e privacidade**.
2. Em **Acesso à ligação**, selecione uma destas opções:
   - **Restrito**: apenas o proprietário e as pessoas convidadas podem abrir a execução.
   - **Qualquer pessoa com a ligação**: qualquer usuário com sessão iniciada que tenha o link pode abrir a execução.
3. Para **Qualquer pessoa com a ligação**, selecione a função que o link concede: **Visualizador** ou **Editor**. Um link nunca concede a função **Proprietário**.
4. Selecione **Copiar ligação**.

O link tem o formato `/share/<token>`. O token é a parte do link difícil de adivinhar. Se o link for revogado, ou se a execução for excluída, o link mostra **Partilha não encontrada**.

> [!NOTE]
> Segredos, como chaves de API e URLs base, nunca aparecem em uma execução compartilhada.

## Convidar pessoas

1. Abra **Partilha e privacidade**.
2. Em **Convidar pessoas**, digite um nome de usuário. A lista mostra até 10 usuários correspondentes.
3. Selecione uma função: **Visualizador** ou **Editor**.
4. Selecione **Convidar**.

**Pessoas com acesso** lista todos que têm uma função na execução. Para cada pessoa, você pode:

- Alterar a função.
- Remover o acesso.

Uma pessoa mantém o acesso mais alto que as regras concedem. Por exemplo, um editor convidado mantém a função **Editor** quando o link concede **Visualizador**.

### Transferir a propriedade

Você pode entregar a execução a outro usuário:

1. Abra o menu de função de uma pessoa em **Pessoas com acesso**. Você também pode usar o menu de função em **Convidar pessoas**.
2. Selecione **Transferir propriedade**.
3. Confirme a transferência.

O novo proprietário recebe controle total. Você passa a ser editor e perde os privilégios de proprietário.

## Visibilidade pública

A visibilidade pública controla se uma execução aparece na pesquisa pública da galeria Explorar. Ela não altera o acesso por link nem os convites.

| Opção          | Significado                                                                     |
| -------------- | ------------------------------------------------------------------------------- |
| **Pública**    | Aparece na pesquisa pública. Visível para todos os usuários.                    |
| **Privada**    | Oculta da pesquisa pública. Visível apenas para você e para as pessoas convidadas. |

Apenas o proprietário pode alterar a visibilidade pública. A alteração tem efeito imediato.

## A galeria Explorar

A página Explorar permite pesquisar otimizações. Ela tem três abas:

| Aba                     | O que mostra                                                  |
| ----------------------- | ------------------------------------------------------------- |
| **Minhas**              | As suas otimizações, privadas e públicas                      |
| **Pública**             | Otimizações públicas de outros usuários                       |
| **Partilhado comigo**   | Otimizações que outros usuários compartilharam com você       |

Use a barra de pesquisa e **Filtros** para encontrar execuções.

Você só pode abrir uma execução pública pelo Explorar se ela terminou com o status `success`. Quando você a abre:

- Você recebe a função **Visualizador**. Você pode ler a execução e cloná-la.
- A página mostra o proprietário da execução.
- O Skynet remove os segredos, como chaves de API e URLs base.
- Você não pode executar o modelo. O modelo gastaria a chave do proprietário.

> [!TIP]
> Para dar mais acesso a uma pessoa em uma execução pública, convide essa pessoa como **Editor**.

## Páginas relacionadas

- [Execuções](/docs/concepts/runs)
- [Ler os resultados](/docs/guides/results)
- [Segurança](/docs/security)
