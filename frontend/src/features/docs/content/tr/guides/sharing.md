Bir çalıştırmayı başkalarıyla paylaşabilir ve herkese açık Keşfet galerisinde listeleyebilirsiniz. Bunlar iki farklı ayardır. Bağlantı erişimi ve davetler, bir çalıştırmayı kimin açabileceğini belirler. Genel görünürlük, çalıştırmanın herkese açık aramada görünüp görünmeyeceğini belirler. Bu kılavuz ikisini de açıklar.

## Varsayılanlar

| Ayar                                        | Yeni bir çalıştırma için varsayılan                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Genel görünürlük                            | **Herkese açık**. Çalıştırma herkese açık aramada listelenir.                        |
| Bağlantı erişimi                            | **Kısıtlı**. Çalıştırmayı yalnızca sahip ve davet edilen kişiler açabilir.           |
| **Bağlantıya sahip herkes** için rol        | **Görüntüleyici**                                                                    |

Gönderme sihirbazı, yeni bir çalıştırmanın görünürlüğünü son ekranında gösterir. Bunu çalıştırma başladıktan sonra **Paylaşım ve gizlilik** iletişim kutusunda değiştirirsiniz.

> [!WARNING]
> Yeni çalıştırmalar varsayılan olarak herkese açıktır. Çalıştırmanız diğer kullanıcıların görmemesi gereken veriler içeriyorsa **Paylaşım ve gizlilik** iletişim kutusunda onu **Özel** olarak ayarlayın.

## Paylaşım ayarlarını açın

Çalıştırma sayfasında **Paylaşım ve gizlilik** seçeneğini seçin. Bu düğmeyi yalnızca çalıştırmanın sahibi görür.

## Roller

Bir çalıştırmayı açabilen her kişinin üç rolden biri vardır:

| Rol                | Kişinin yapabilecekleri                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Görüntüleyici**  | Çalıştırmayı açar, sonuçlarını ve sahibini görür. Çalıştırmayı klonlar.                                                                                       |
| **Düzenleyici**    | Görüntüleyici erişimine ek olarak modeli çalıştırma, sohbet ve yeniden adlandırma. Düzenleyici çalıştırmayı iptal edebilir, duraklatabilir, devam ettirebilir ve yeniden deneyebilir. |
| **Sahip**          | Paylaşımı ve silmeyi yönetmek dahil tam denetim.                                                                                                              |

Bir çalıştırmanın tam olarak bir sahibi vardır. Paylaşılan bir çalıştırmayı açan herkes oturum açmalıdır. Paylaşılan bir çalıştırmaya anonim erişim yoktur.

## Bağlantı paylaşın

1. **Paylaşım ve gizlilik** iletişim kutusunu açın.
2. **Bağlantı erişimi** altında şu seçeneklerden birini seçin:
   - **Kısıtlı**: çalıştırmayı yalnızca sahip ve davet edilen kişiler açabilir.
   - **Bağlantıya sahip herkes**: bağlantıya sahip, oturum açmış her kullanıcı çalıştırmayı açabilir.
3. **Bağlantıya sahip herkes** için bağlantının verdiği rolü seçin: **Görüntüleyici** veya **Düzenleyici**. Bir bağlantı hiçbir zaman **Sahip** rolünü vermez.
4. **Bağlantıyı kopyala** seçeneğini seçin.

Bağlantı `/share/<token>` biçimindedir. Token, bağlantının tahmin edilmesi zor olan kısmıdır. Bağlantı iptal edilirse veya çalıştırma silinirse bağlantı **Paylaşım bulunamadı** gösterir.

> [!NOTE]
> API anahtarları ve temel URL'ler gibi gizli bilgiler, paylaşılan bir çalıştırmada hiçbir zaman görünmez.

## Kişileri davet edin

1. **Paylaşım ve gizlilik** iletişim kutusunu açın.
2. **Kişileri davet et** altında bir kullanıcı adı girin. Liste eşleşen en fazla 10 kullanıcıyı gösterir.
3. Bir rol seçin: **Görüntüleyici** veya **Düzenleyici**.
4. **Davet et** seçeneğini seçin.

**Erişimi olan kişiler**, çalıştırmada rolü olan herkesi listeler. Her kişi için şunları yapabilirsiniz:

- Rolü değiştirmek.
- Erişimi kaldırmak.

Bir kişi, kuralların verdiği en yüksek erişimi korur. Örneğin bağlantı **Görüntüleyici** rolünü verse bile davet edilmiş bir düzenleyici **Düzenleyici** rolünü korur.

### Sahipliği devredin

Çalıştırmayı başka bir kullanıcıya verebilirsiniz:

1. **Erişimi olan kişiler** içinde bir kişinin rol menüsünü açın. **Kişileri davet et** altındaki rol menüsünü de kullanabilirsiniz.
2. **Sahipliği devret** seçeneğini seçin.
3. Devri onaylayın.

Yeni sahip tam denetim alır. Siz düzenleyici olursunuz ve sahip ayrıcalıklarını kaybedersiniz.

## Genel görünürlük

Genel görünürlük, bir çalıştırmanın Keşfet galerisindeki herkese açık aramada görünüp görünmeyeceğini belirler. Bağlantı erişimini veya davetleri değiştirmez.

| Seçenek             | Anlamı                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------ |
| **Herkese açık**    | Herkese açık aramada listelenir. Tüm kullanıcılar görebilir.                               |
| **Özel**            | Herkese açık aramadan gizlenir. Yalnızca siz ve davet edilen kişiler görebilir.            |

Genel görünürlüğü yalnızca sahip değiştirebilir. Değişiklik hemen geçerli olur.

## Keşfet galerisi

Keşfet sayfası optimizasyonlarda arama yapmanızı sağlar. Üç sekmesi vardır:

| Sekme                         | Ne gösterir                                           |
| ----------------------------- | ----------------------------------------------------- |
| **Benimkiler**                | Özel ve herkese açık optimizasyonlarınız              |
| **Herkese açık**              | Diğer kullanıcıların herkese açık optimizasyonları    |
| **Benimle paylaşılanlar**     | Diğer kullanıcıların sizinle paylaştığı optimizasyonlar |

Çalıştırma bulmak için arama çubuğunu ve **Filtreler** seçeneğini kullanın.

Keşfet'ten herkese açık bir çalıştırmayı yalnızca `success` durumuyla bittiyse açabilirsiniz. Açtığınızda:

- **Görüntüleyici** rolünü alırsınız. Çalıştırmayı okuyabilir ve klonlayabilirsiniz.
- Sayfa çalıştırmanın sahibini gösterir.
- Skynet, API anahtarları ve temel URL'ler gibi gizli bilgileri kaldırır.
- Modeli çalıştıramazsınız. Model, sahibin anahtarından harcama yapardı.

> [!TIP]
> Herkese açık bir çalıştırmada bir kişiye daha fazla erişim vermek için o kişiyi **Düzenleyici** olarak davet edin.

## İlgili sayfalar

- [Çalıştırmalar](/docs/concepts/runs)
- [Sonuçları okuyun](/docs/guides/results)
- [Güvenlik](/docs/security)
