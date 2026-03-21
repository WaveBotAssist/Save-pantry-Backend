var express = require('express');
var router = express.Router();
const geminiApi = require('../services/ApiGemini')

router.post('/sendtext', async (req, res) => {
    try {
        const { scanner } = req.body
        const resp = await geminiApi(scanner)
      
        res.status(200).json({
            result: true,
            response: resp
        })
    }
    catch (error) {
        res.status(500).json({
            result: false,
            message: error.message
        })
    }
})

module.exports = router