# Contributing to Basalt

Thank you for wanting to help. Basalt is made by Refora Technologies and is open
to everyone's help: fixes, testing on hardware and systems we don't have,
better docs, and ideas.

## Ways to help

- **Ask and answer questions** in [Help and setup](https://github.com/refora-technologies/basalt/discussions/categories/help-and-setup).
  Every answered question helps the next person.
- **Suggest ideas** in [Ideas](https://github.com/refora-technologies/basalt/discussions/categories/ideas),
  and vote for the ones you want.
- **Report bugs** as [issues](https://github.com/refora-technologies/basalt/issues/new/choose),
  with the form's details filled in.
- **Show your setup** in [Your setup](https://github.com/refora-technologies/basalt/discussions/categories/your-setup):
  a NAS, a Raspberry Pi, an old laptop under the TV.
- **Send a change** as a pull request, as below.

Security problems are the exception: report them privately, as
[SECURITY.md](SECURITY.md) explains.

## Before a bigger change

For anything larger than a fix, such as a new feature, a new setting, or a change
to how something looks or works, start a discussion in Ideas first. Basalt
stays deliberately simple, and it's better to agree on the shape of a change
before you spend time on it.

## Building and testing

How to build the apps, the Linux packages and the Docker image is in the
[README](README.md#building-from-source). Once per clone, turn on the checks
that run before every commit:

```sh
git config core.hooksPath .githooks
```

They run `cargo fmt --check`, `cargo clippy` with warnings as errors, the Rust
test suite, and the type checks and tests of both apps. A pull request should
pass all of them. Please don't skip them with `--no-verify`.

New behaviour comes with a test, and a fix with a test that failed before it.
Tests never use the computer's real security chip or the user's real Basalt
settings: they make their own keys and folders.

## How Basalt is written

- **Plain words.** Everything a person reads, in the apps, the messages, the
  docs and the release notes, says what it means in everyday words. "Your
  computer", not "the client machine"; "Basalt can't reach the host", not
  "ECONNREFUSED". No emoji.
- **Private by default.** Nothing new leaves the user's network unless they
  turn it on, and the [privacy policy](https://basalt.reforatech.com/privacy/)
  is updated with it.
- **The code explains why.** Comments say why something is the way it is,
  in the same plain words.
- **Small, clear commits** with short messages that say what changed, such as
  "Keep fields above the keyboard on Android".

## Sending a pull request

1. Fork the repository and make a branch from `main`.
2. Make the change, with its tests, and check that the commit checks pass.
3. Open a pull request against `main`. Say what it changes and why, how you
   tested it, and on what (Windows, Linux, Android, Docker).
4. Tick the contributor terms in the pull request form.

`main` is always ready to release, so changes are reviewed before they are
merged, and may be asked to change.

## Contributor terms

Basalt is published under the GNU General Public License v3.0. By sending a
pull request, you agree that:

1. **It's yours to give.** You wrote the contribution, or have the right to
   submit it, and it carries no obligations that conflict with these terms.
2. **It's published under the GPLv3,** like the rest of Basalt.
3. **Refora Technologies may also use it under other terms.** You grant Refora
   Technologies a perpetual, worldwide, non-exclusive, royalty-free and
   irrevocable licence to use, copy, change, distribute and sublicense your
   contribution, including under licences other than the GPLv3. This lets
   Refora Technologies keep Basalt's licensing options open in future, such as
   offering it under a commercial licence alongside the GPLv3.
4. **You keep your copyright.** These terms give rights; they don't take
   ownership of your work, and you can use your own contribution however you
   like.

If you can't agree to these terms, for example because your employer owns your
work, please say so in the pull request before it is merged.

## Code of conduct

Be kind and patient. Everyone here, from first-time users to long-time
contributors, deserves a respectful answer. Disagree about ideas, never about
people. Harassment, insults and discrimination of any kind aren't welcome, and
comments or people who don't respect this may be removed. Tell us about a
problem at reforatech@gmail.com.
