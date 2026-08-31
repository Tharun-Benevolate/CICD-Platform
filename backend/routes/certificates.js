const router = require("express").Router();
const auth = require("../middleware/auth");
const aws = require("../aws");

// GET /api/certificates
// Fetches all ACM certificates and their statuses
router.get("/certificates", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const region = req.query.region || process.env.AWS_REGION || "us-east-1";
    
    // List all certificates
    const certs = await aws.listCertificates(region);
    
    // Fetch detailed status for each certificate (up to 10 to avoid throttling on large accounts)
    // For a real production system with many certs, you'd want to paginate or filter this
    const detailedCerts = await Promise.all(
      certs.slice(0, 50).map(async (cert) => {
        try {
          const detail = await aws.describeCertificate(region, cert.CertificateArn);
          return {
            domainName: detail.DomainName,
            status: detail.Status,
            inUseBy: detail.InUseBy || [],
            type: detail.Type,
            createdAt: detail.CreatedAt,
            issuedAt: detail.IssuedAt,
            arn: detail.CertificateArn,
            subjectAlternativeNames: detail.SubjectAlternativeNames || []
          };
        } catch (err) {
          return {
            domainName: cert.DomainName,
            status: "ERROR_FETCHING",
            arn: cert.CertificateArn
          };
        }
      })
    );
    
    res.json({ ok: true, certificates: detailedCerts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
