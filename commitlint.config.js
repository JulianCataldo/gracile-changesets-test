// Lightweight commit-message hygiene gate.
// Not extending @commitlint/config-conventional — release intent is driven by
// Changesets, not commit-message parsing.
//
// Lintable subset of cbea.ms/git-commit/ "seven rules":
//   1. Separate subject from body .... body-leading-blank, footer-leading-blank
//   2. Subject ≤ 72 chars ............ header-max-length
//   3. Capitalize subject ............ subject-case
//   4. No period at end .............. subject-full-stop
//   5. Imperative mood ............... NOT reliably lintable — skipped
//   6. Wrap body at 72 chars ......... body-max-line-length
//   7. What & why, not how ........... NOT lintable — skipped

/** @type {import('@commitlint/types').UserConfig} */
export default {
	parserPreset: {
		parserOpts: {
			headerPattern: /^(.*)$/,
			headerCorrespondence: ['subject'],
		},
	},
	rules: {
		'body-leading-blank': [2, 'always'],
		'footer-leading-blank': [2, 'always'],
		'header-max-length': [2, 'always', 72],
		'header-trim': [2, 'always'],
		'subject-case': [
			2,
			'never',
			['lower-case', 'pascal-case', 'snake-case', 'kebab-case'],
		],
		'subject-empty': [2, 'never'],
		'subject-full-stop': [2, 'never', '.'],
		'body-max-line-length': [2, 'always', 72],
	},
};
