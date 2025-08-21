import { config as dotenv } from "dotenv";
import {
    createWalletClient,
    http,
    getContract,
    erc20Abi,
    parseUnits,
    maxUint256,
    publicActions,
    concat,
    numberToHex,
    size,
} from "viem";
import * as util from "util";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wethAbi } from "../abi/weth-abi.json";
import { log } from "console";

// const qs = require("qs");

// load env vars
dotenv();
const { PRIVATE_KEY, ZERO_EX_API_KEY, RPC_URL } = process.env;

// validate requirements
if (!PRIVATE_KEY) throw new Error("missing PRIVATE_KEY.");
if (!ZERO_EX_API_KEY) throw new Error("missing ZERO_EX_API_KEY.");
if (!RPC_URL) throw new Error("missing RPC_URL.");

// fetch headers
const headers = new Headers({
    "Content-Type": "application/json",
    "0x-api-key": ZERO_EX_API_KEY,
    "0x-version": "v2",
});

// setup wallet client
const client = createWalletClient({
    account: privateKeyToAccount(`0x${PRIVATE_KEY}` as `0x${string}`),
    chain: base,
    transport: http(RPC_URL),
}).extend(publicActions); // extend wallet client with publicActions for public client

// const [address] = await client.getAddresses();

// set up contracts
const usdc = getContract({
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    abi: erc20Abi,
    client,
});
const weth = getContract({
    address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
    abi: wethAbi,
    client,
});

const main = async () => {
    // specify sell amount
    const sellAmount = parseUnits("1", await usdc.read.decimals());

    // 1. fetch price
    console.log(
        "\n\n\n#################################   GETTING PRICE   ##################################"
    );
    const priceParams = new URLSearchParams({
        chainId: client.chain.id.toString(),
        sellToken: usdc.address,
        buyToken: weth.address,
        sellAmount: sellAmount.toString(),
        taker: client.account.address,
    });

    const priceResponse = await fetch(
        "https://api.0x.org/swap/permit2/price?" + priceParams.toString(),
        {
            headers,
        }
    );

    const price = await priceResponse.json();

    console.log("Fetching price to swap 0.1 USDC for WETH");
    console.log(
        `https://api.0x.org/swap/permit2/price?${priceParams.toString()}`
    );
    console.log(
        "priceResponse: ",
        util.inspect(price, { depth: null, colors: true })
    );
    console.log(
        "#####################################################################################\n\n\n"
    );

    // 2. check if taker needs to set an allowance for Permit2
    console.log(
        "#################################   APPROVING PERMIT 2   ##################################"
    );
    if (price.issues.allowance !== null) {
        try {
            const { request } = await usdc.simulate.approve([
                price.issues.allowance.spender,
                maxUint256,
            ]);
            console.log("Approving Permit2 to spend USDC...", request);
            // set approval
            const hash = await usdc.write.approve(request.args);
            console.log(
                "Approved Permit2 to spend USDC.",
                await client.waitForTransactionReceipt({ hash })
            );
        } catch (error) {
            console.log("Error approving Permit2:", error);
        }
    } else {
        console.log("USDC already approved for Permit2");
    }
    console.log(
        "#####################################################################################\n\n\n"
    );

    // 3. fetch quote
    console.log(
        "#################################   FETCHING QUOTE   ##################################"
    );
    const quoteParams = new URLSearchParams();
    for (const [key, value] of priceParams.entries()) {
        quoteParams.append(key, value);
    }

    log(
        "quote URL: \n" +
            "https://api.0x.org/swap/permit2/quote?" +
            quoteParams.toString()
    );

    // const swapFeeRecipient = "0x88eA766075Cc481357F6a7F3De7775e5b6709b2B"; // Wallet address that should receive the affiliate fees
    // const swapFeeBps = 100; // Percentage of buyAmount that should be attributed as affiliate fees
    // const swapFeeToken = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

    // quoteParams.append("swapFeeRecipient", swapFeeRecipient);
    // quoteParams.append("swapFeeBps", swapFeeBps.toString());
    // quoteParams.append("swapFeeToken", swapFeeToken);

    const quoteResponse = await fetch(
        "https://api.0x.org/swap/permit2/quote?" + quoteParams.toString(),
        {
            headers,
        }
    );

    const quote = await quoteResponse.json();
    console.log("Fetching quote to swap 0.1 USDC for WETH");
    console.log("quoteResponse: ", JSON.stringify(quote));
    console.log(
        "#####################################################################################\n\n\n"
    );

    // 4. sign permit2.eip712 returned from quote
    console.log(
        "###########################   SIGNING PERMIT 2 OBJECT   #############################"
    );
    let signature: Hex | undefined;
    if (quote.permit2?.eip712) {
        try {
            signature = await client.signTypedData(quote.permit2.eip712);
            console.log("Signed permit2 message from quote response");
        } catch (error) {
            console.error("Error signing permit2 coupon:", error);
        }

        // 5. append sig length and sig data to transaction.data
        if (signature && quote?.transaction?.data) {
            const signatureLengthInHex = numberToHex(size(signature), {
                signed: false,
                size: 32,
            });

            const transactionData = quote.transaction.data as Hex;
            const sigLengthHex = signatureLengthInHex as Hex;
            const sig = signature as Hex;

            quote.transaction.data = concat([
                transactionData,
                sigLengthHex,
                sig,
            ]);
        } else {
            throw new Error("Failed to obtain signature or transaction data");
        }
    }
    console.log(
        "#####################################################################################\n\n\n"
    );
    // 6. submit txn with permit2 signature
    console.log(
        "#############################   TRYING TO SEND THE TX   ##############################"
    );
    if (signature && quote.transaction.data) {
        const nonce = await client.getTransactionCount({
            address: client.account.address,
        });

        const signedTransaction = await client.signTransaction({
            account: client.account,
            chain: client.chain,
            gas: !!quote?.transaction.gas
                ? BigInt(quote?.transaction.gas)
                : undefined,
            to: quote?.transaction.to,
            data: quote.transaction.data,
            value: quote?.transaction.value
                ? BigInt(quote.transaction.value)
                : undefined, // value is used for native tokens
            gasPrice: !!quote?.transaction.gasPrice
                ? BigInt(quote?.transaction.gasPrice)
                : undefined,
            nonce: nonce,
        });
        const hash = await client.sendRawTransaction({
            serializedTransaction: signedTransaction,
        });

        console.log("Transaction hash:", hash);

        const receipt = await client.waitForTransactionReceipt({ hash });
        console.log(
            "Transaction status:",
            receipt.status === "success" ? "Success" : "Failed"
        );
        console.log(
            "#####################################################################################\n\n\n"
        );
        return receipt.status === "success" ? 1 : 0; // return 1 for success, 0 for failure
    } else {
        console.error("Failed to obtain a signature, transaction not sent.");
        console.log(
            "#####################################################################################\n\n\n"
        );
        return 2;
    }
};

async function bulkTest() {
    const FgYellow = "\x1b[33m";
    let success = 0;
    let failed = 0;
    let notSent = 0;
    let total = 0;
    for (let i = 0; i < 50; i++) {
        console.log(
            `${FgYellow}======================================================`
        );
        console.log(
            `${FgYellow}================== Transaction ${i} ====================`
        );
        console.log(
            `${FgYellow}======================================================`
        );

        let res = await main();
        if (res === 1) {
            success++;
        } else if (res === 0) {
            failed++;
            console.log("TRANSACTION FAILED, BREAKING LOOP");
            break;
        } else {
            notSent++;
        }
        total++;
    }
    console.log(`Total successes: ${success}`);
    console.log(`Total failures: ${failed}`);
    console.log(`Total not sent: ${notSent}`);
    const usdcBalance = await usdc.read.balanceOf([client.account.address]);
    const daiBalance = (await weth.read.balanceOf([
        client.account.address,
    ])) as bigint;
    console.log(`USDC Balance: ${Number(usdcBalance) / 10 ** 6}`);
    console.log(`DAI Balance: ${Number(daiBalance) / 10 ** 18}`);
}

bulkTest()
    .then(() => {
        console.log("Bulk test completed successfully.");
    })
    .catch((error) => {
        console.error("Error during bulk test:", error);
    });
