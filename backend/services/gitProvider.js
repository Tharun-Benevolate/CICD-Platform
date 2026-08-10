// services/gitProvider.js — Factory that returns the correct git provider implementation.
// Usage: const provider = getProvider("github");
//        await provider.getFileContent(owner, repo, path, ref);

function getProvider(providerName) {
  switch (providerName) {
    case "github":     return require("./providers/githubProvider");
    case "gitlab":     return require("./providers/gitlabProvider");
    case "codecommit": return require("./providers/codecommitProvider");
    case "bitbucket":  return require("./providers/bitbucketProvider");
    default:
      throw new Error(`Unknown git provider: "${providerName}". Valid values: github, gitlab, codecommit, bitbucket`);
  }
}

module.exports = { getProvider };
