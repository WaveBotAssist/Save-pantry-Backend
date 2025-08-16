const User = require('../models/users')
const Product = require('../models/product')
//Fonction de mise à jour du prix,  pour ajouté ou retiré une donnée a mettre a jour c est ici.
const updateProductPrice = async (codebarre) => {
    try {
        console.log(`🔄 Début de la mise à jour pour le code-barres : ${codebarre}`);
  
        // 🔍 Étape 1 : Trouver les utilisateurs ayant ce code-barres
        const usersWithProduct = await User.find({ "myproducts.codebarre": codebarre });
        console.log("👥 Utilisateurs trouvés :", usersWithProduct.length);
  
        // 📊 Étape 2 : Extraire les prix, noms et dates pour ce code-barres
        const productData = usersWithProduct
            .flatMap(user => user.myproducts) // Parcourir tous les sous-documents myproducts
            .filter(product => product.codebarre === codebarre) // Filtrer par code-barres
            .map(product => ({
                prix: product.prix, 
                updatedAt: product.updatedAt || new Date(), 
            }));
  
        console.log("📌 Données associées à ce code-barres :", productData);
  
        // Si aucun produit n'est trouvé, arrêter la mise à jour
        if (productData.length === 0) {
            console.error("⚠️ Aucun produit trouvé pour ce code-barres :", codebarre);
            return;
        }
  
        // 🕒 Étape 3 : Trouver le prix et le nom les plus récents
        const mostRecentData = productData.reduce((latest, current) =>
            new Date(current.updatedAt) > new Date(latest.updatedAt) ? current : latest,
        productData[0]);
  
        console.log("✅ Données les plus récentes trouvées :", mostRecentData);
  
        // 🔄 Étape 4 : Mettre à jour le prix et le nom dans la collection `products`
        const updatedProduct = await Product.findOneAndUpdate(
            { codebarre },
            { $set: { 
                prix: mostRecentData.prix, 
                lastUpdated: new Date() 
            }},
            { new: true }
        );
  
        if (updatedProduct) {
            console.log("🎯 Produit mis à jour dans 'products' :", updatedProduct);
        } 
    } catch (err) {
        console.error(`❌ Erreur lors de la mise à jour du produit ${codebarre} :`, err.message);
    }
  };
  
  module.exports = updateProductPrice