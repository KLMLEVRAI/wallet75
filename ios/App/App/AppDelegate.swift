import UIKit
import SwiftUI

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private let walletViewModel = WalletViewModel()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let rootView = WalletRootView(viewModel: walletViewModel)
        let hostingController = UIHostingController(rootView: rootView)
        hostingController.overrideUserInterfaceStyle = .dark

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = hostingController
        window.makeKeyAndVisible()
        self.window = window

        return true
    }
}

private enum WalletTab {
    case wallet
    case market
    case settings
}

private enum ConnectionStatus {
    case local
    case online
    case offline
}

private struct WalletSnapshot: Codable {
    let holdings: [String: Double]
    let updatedAt: Date
}

private struct BridgeWalletPayload: Decodable {
    let holdings: [String: Double]
    let updatedAt: String?
}

private struct MarketSparkline: Decodable {
    let price: [Double]
}

private struct MarketCoin: Decodable, Identifiable {
    let id: String
    let symbol: String
    let name: String
    let image: String
    let currentPrice: Double
    let marketCap: Double?
    let change24h: Double?
    let sparkline7d: MarketSparkline?

    private enum CodingKeys: String, CodingKey {
        case id
        case symbol
        case name
        case image
        case currentPrice = "current_price"
        case marketCap = "market_cap"
        case change24h = "price_change_percentage_24h"
        case sparkline7d = "sparkline_in_7d"
    }
}

private struct PortfolioCoin: Identifiable {
    let id: String
    let symbol: String
    let name: String
    let imageURL: String
    let currentPrice: Double
    let marketCap: Double
    let change24h: Double?
    let amount: Double
    let usdValue: Double
    let sparkline: [Double]
}

@MainActor
private final class WalletViewModel: ObservableObject {
    @Published var marketCoins: [MarketCoin] = []
    @Published var holdings: [String: Double]
    @Published var walletUpdatedAt: Date
    @Published var lastMarketSync: Date?
    @Published var marketError = ""
    @Published var marketQuery = ""
    @Published var bridgeURLInput: String
    @Published private(set) var bridgeURL: String
    @Published private(set) var connectionStatus: ConnectionStatus = .local
    @Published private(set) var isRefreshing = false

    private var hasStarted = false
    private var marketTimer: Timer?
    private var bridgeTimer: Timer?

    private static let snapshotKey = "wallet75.swift.snapshot"
    private static let bridgeURLKey = "wallet75.swift.bridgeURL"
    private static let defaultBridge = "http://192.168.1.58:8787"
    private static let defaultHoldings: [String: Double] = [
        "BTC": 0.14,
        "ETH": 1.9,
        "SOL": 42,
        "USDC": 3200,
        "SUI": 850,
        "BONK": 950000,
    ]

    private let userDefaults = UserDefaults.standard
    private let decoder = JSONDecoder()
    private let isoFormatter = ISO8601DateFormatter()

    init() {
        if let savedBridge = userDefaults.string(forKey: Self.bridgeURLKey), !savedBridge.isEmpty {
            bridgeURL = savedBridge
        } else {
            bridgeURL = Self.defaultBridge
        }

        bridgeURLInput = Self.displayBridgeURL(bridgeURL)

        if
            let snapshotData = userDefaults.data(forKey: Self.snapshotKey),
            let snapshot = try? decoder.decode(WalletSnapshot.self, from: snapshotData)
        {
            holdings = snapshot.holdings
            walletUpdatedAt = snapshot.updatedAt
        } else {
            holdings = Self.defaultHoldings
            walletUpdatedAt = Date()
        }
    }

    deinit {
        marketTimer?.invalidate()
        bridgeTimer?.invalidate()
    }

    func startIfNeeded() {
        guard !hasStarted else {
            return
        }

        hasStarted = true

        Task {
            await refreshAll()
        }

        marketTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { [weak self] _ in
            guard let self else {
                return
            }

            Task {
                await self.refreshMarket()
            }
        }

        bridgeTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self else {
                return
            }

            Task {
                await self.syncBridgeState()
            }
        }

        if let marketTimer {
            RunLoop.main.add(marketTimer, forMode: .common)
        }

        if let bridgeTimer {
            RunLoop.main.add(bridgeTimer, forMode: .common)
        }
    }

    func refreshAll() async {
        if isRefreshing {
            return
        }

        isRefreshing = true

        defer {
            isRefreshing = false
        }

        await refreshMarket()
        await syncBridgeState()
    }

    func saveBridgeURL() {
        let normalized = Self.normalizeBridgeURL(bridgeURLInput)

        bridgeURL = normalized
        bridgeURLInput = Self.displayBridgeURL(normalized)
        userDefaults.set(normalized, forKey: Self.bridgeURLKey)

        Task {
            await syncBridgeState()
        }
    }

    func testBridgeNow() async {
        await syncBridgeState()
    }

    var connectionLabel: String {
        switch connectionStatus {
        case .local:
            return "Mode local (snapshot)"
        case .online:
            return "Bridge en ligne: \(bridgeURL)"
        case .offline:
            return "Bridge hors ligne"
        }
    }

    var portfolioValue: Double {
        enrichedCoins.reduce(0) { $0 + $1.usdValue }
    }

    var trackedAssets: [PortfolioCoin] {
        enrichedCoins
            .filter { $0.amount > 0 }
            .sorted { first, second in
                if first.usdValue != second.usdValue {
                    return first.usdValue > second.usdValue
                }

                return first.marketCap > second.marketCap
            }
    }

    var filteredMarket: [PortfolioCoin] {
        let query = marketQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        return enrichedCoins
            .filter { coin in
                guard !query.isEmpty else {
                    return true
                }

                return coin.name.lowercased().contains(query) || coin.symbol.lowercased().contains(query)
            }
            .sorted { first, second in
                if first.amount > 0 && second.amount == 0 {
                    return true
                }

                if first.amount == 0 && second.amount > 0 {
                    return false
                }

                if first.usdValue != second.usdValue {
                    return first.usdValue > second.usdValue
                }

                return first.marketCap > second.marketCap
            }
    }

    var topMovers: [PortfolioCoin] {
        enrichedCoins
            .filter { $0.change24h != nil }
            .sorted { ($0.change24h ?? 0) > ($1.change24h ?? 0) }
            .prefix(4)
            .map { $0 }
    }

    private var enrichedCoins: [PortfolioCoin] {
        marketCoins.map { coin in
            let symbol = coin.symbol.uppercased()
            let amount = holdings[symbol] ?? 0

            return PortfolioCoin(
                id: coin.id,
                symbol: symbol,
                name: coin.name,
                imageURL: coin.image,
                currentPrice: coin.currentPrice,
                marketCap: coin.marketCap ?? 0,
                change24h: coin.change24h,
                amount: amount,
                usdValue: amount * coin.currentPrice,
                sparkline: coin.sparkline7d?.price ?? []
            )
        }
    }

    private func refreshMarket() async {
        do {
            async let firstPage = fetchMarketPage(page: 1)
            async let secondPage = fetchMarketPage(page: 2)

            let combined = try await firstPage + secondPage
            var seenSymbols = Set<String>()
            var uniqueCoins: [MarketCoin] = []

            for coin in combined {
                let symbol = coin.symbol.uppercased()

                if seenSymbols.contains(symbol) {
                    continue
                }

                seenSymbols.insert(symbol)
                uniqueCoins.append(coin)
            }

            marketCoins = uniqueCoins
            lastMarketSync = Date()
            marketError = ""
        } catch {
            marketError = "Erreur market: \(error.localizedDescription)"
        }
    }

    private func fetchMarketPage(page: Int) async throws -> [MarketCoin] {
        let query = "vs_currency=usd&order=market_cap_desc&per_page=250&page=\(page)&sparkline=true&price_change_percentage=24h"
        guard let url = URL(string: "https://api.coingecko.com/api/v3/coins/markets?\(query)") else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }

        return try decoder.decode([MarketCoin].self, from: data)
    }

    private func syncBridgeState() async {
        guard !bridgeURL.isEmpty else {
            connectionStatus = .local
            return
        }

        guard let endpointURL = URL(string: Self.stateEndpoint(from: bridgeURL)) else {
            connectionStatus = .offline
            return
        }

        var request = URLRequest(url: endpointURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 3.5

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }

            let payload = try decoder.decode(BridgeWalletPayload.self, from: data)

            var safeHoldings: [String: Double] = [:]

            for (symbol, amount) in payload.holdings {
                let normalized = symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()

                guard !normalized.isEmpty, amount.isFinite, amount >= 0 else {
                    continue
                }

                safeHoldings[normalized] = amount
            }

            if !safeHoldings.isEmpty {
                holdings = safeHoldings
            }

            walletUpdatedAt = Self.parseDate(payload.updatedAt, formatter: isoFormatter) ?? Date()
            persistSnapshot()
            connectionStatus = .online
        } catch {
            connectionStatus = .offline
        }
    }

    private func persistSnapshot() {
        let snapshot = WalletSnapshot(holdings: holdings, updatedAt: walletUpdatedAt)

        if let data = try? JSONEncoder().encode(snapshot) {
            userDefaults.set(data, forKey: Self.snapshotKey)
        }
    }

    private static func normalizeBridgeURL(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmed.isEmpty else {
            return ""
        }

        if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://") {
            return trimmed.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        }

        return "http://\(trimmed.replacingOccurrences(of: "/+$", with: "", options: .regularExpression))"
    }

    private static func displayBridgeURL(_ normalizedValue: String) -> String {
        normalizedValue
            .replacingOccurrences(of: "http://", with: "")
            .replacingOccurrences(of: "https://", with: "")
    }

    private static func stateEndpoint(from bridgeURL: String) -> String {
        if bridgeURL.hasSuffix("/state") {
            return bridgeURL
        }

        return "\(bridgeURL)/state"
    }

    private static func parseDate(_ value: String?, formatter: ISO8601DateFormatter) -> Date? {
        guard let value, !value.isEmpty else {
            return nil
        }

        return formatter.date(from: value)
    }
}

private struct WalletRootView: View {
    @ObservedObject var viewModel: WalletViewModel
    @State private var selectedTab: WalletTab = .wallet
    @State private var animateBackground = false

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.07, green: 0.05, blue: 0.18), Color(red: 0.09, green: 0.08, blue: 0.24)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            Circle()
                .fill(
                    RadialGradient(
                        colors: [Color(red: 0.53, green: 0.34, blue: 1.0), Color.clear],
                        center: .center,
                        startRadius: 20,
                        endRadius: 180
                    )
                )
                .frame(width: 330, height: 330)
                .blur(radius: 55)
                .offset(x: animateBackground ? -120 : -75, y: animateBackground ? -250 : -200)
                .animation(.easeInOut(duration: 14).repeatForever(autoreverses: true), value: animateBackground)

            Circle()
                .fill(
                    RadialGradient(
                        colors: [Color(red: 0.37, green: 0.58, blue: 1.0), Color.clear],
                        center: .center,
                        startRadius: 12,
                        endRadius: 150
                    )
                )
                .frame(width: 290, height: 290)
                .blur(radius: 55)
                .offset(x: animateBackground ? 145 : 95, y: animateBackground ? 350 : 305)
                .animation(.easeInOut(duration: 16).repeatForever(autoreverses: true), value: animateBackground)

            TabView(selection: $selectedTab) {
                WalletHomeView(viewModel: viewModel)
                    .tabItem {
                        Label("Wallet", systemImage: "wallet.pass.fill")
                    }
                    .tag(WalletTab.wallet)

                MarketView(viewModel: viewModel)
                    .tabItem {
                        Label("Market", systemImage: "chart.line.uptrend.xyaxis")
                    }
                    .tag(WalletTab.market)

                SettingsView(viewModel: viewModel)
                    .tabItem {
                        Label("Settings", systemImage: "gearshape.fill")
                    }
                    .tag(WalletTab.settings)
            }
            .accentColor(.white)
        }
        .onAppear {
            animateBackground = true
            viewModel.startIfNeeded()
        }
    }
}

private struct WalletHomeView: View {
    @ObservedObject var viewModel: WalletViewModel

    var body: some View {
        NavigationView {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 12) {
                    balanceCard
                    moversCard
                    assetsCard
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, 24)
            }
            .refreshable {
                await viewModel.refreshAll()
            }
            .navigationTitle("Wallet")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(viewModel.isRefreshing ? "Sync..." : "Refresh") {
                        Task {
                            await viewModel.refreshAll()
                        }
                    }
                    .disabled(viewModel.isRefreshing)
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private var balanceCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Total Balance")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.85))

            Text(currency(viewModel.portfolioValue))
                .font(.system(size: 40, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.6)

            Text("\(viewModel.trackedAssets.count) assets  |  Sync \(time(viewModel.lastMarketSync))")
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.7))

            HStack(spacing: 8) {
                quickAction("Receive")
                quickAction("Send")
                quickAction("Swap")
                quickAction("Buy")
            }
        }
        .glassCard(primary: true)
    }

    private var moversCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Top Movers")
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .foregroundStyle(.white)

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(viewModel.topMovers) { coin in
                    HStack(spacing: 10) {
                        AsyncLogo(urlString: coin.imageURL)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(coin.symbol)
                                .font(.system(size: 12, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)

                            Text(percent(coin.change24h))
                                .font(.system(size: 12, weight: .semibold, design: .rounded))
                                .foregroundStyle((coin.change24h ?? 0) >= 0 ? Color.green.opacity(0.95) : Color.red.opacity(0.95))
                        }

                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                }
            }
        }
        .glassCard()
    }

    private var assetsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Tokens")
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)

                Spacer()

                Text("\(viewModel.trackedAssets.count)")
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.75))
            }

            if viewModel.trackedAssets.isEmpty {
                Text("Aucun token detecte. Modifie les soldes depuis ton terminal.")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.72))
            } else {
                LazyVStack(spacing: 8) {
                    ForEach(Array(viewModel.trackedAssets.prefix(40).enumerated()), id: \.element.id) { index, coin in
                        TokenRowView(coin: coin, showSparkline: index < 24)
                    }
                }
            }
        }
        .glassCard()
    }

    private func quickAction(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct MarketView: View {
    @ObservedObject var viewModel: WalletViewModel

    var body: some View {
        NavigationView {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 12) {
                    VStack(spacing: 10) {
                        HStack {
                            Image(systemName: "magnifyingglass")
                                .foregroundStyle(.white.opacity(0.6))

                            TextField("Search BTC, SOL, ETH...", text: $viewModel.marketQuery)
                                .textInputAutocapitalization(.never)
                                .disableAutocorrection(true)
                                .foregroundStyle(.white)
                        }
                        .padding(11)
                        .background(.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                        if !viewModel.marketError.isEmpty {
                            Text(viewModel.marketError)
                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                .foregroundStyle(.red.opacity(0.9))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .glassCard()

                    VStack(spacing: 8) {
                        ForEach(Array(viewModel.filteredMarket.prefix(180).enumerated()), id: \.element.id) { index, coin in
                            MarketRowView(rank: index + 1, coin: coin)
                        }
                    }
                    .glassCard()
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, 24)
            }
            .refreshable {
                await viewModel.refreshAll()
            }
            .navigationTitle("Market")
        }
        .navigationViewStyle(.stack)
    }
}

private struct SettingsView: View {
    @ObservedObject var viewModel: WalletViewModel

    var body: some View {
        NavigationView {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Bridge IP")
                            .font(.system(size: 16, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)

                        Text("Mets l'IP de ton PC ici. Exemple: 192.168.1.58:8787")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.72))

                        TextField("192.168.1.58:8787", text: $viewModel.bridgeURLInput)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)
                            .foregroundStyle(.white)
                            .padding(11)
                            .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))

                        HStack(spacing: 8) {
                            Button("Sauver") {
                                viewModel.saveBridgeURL()
                            }
                            .settingsActionButtonStyle()

                            Button("Tester") {
                                Task {
                                    await viewModel.testBridgeNow()
                                }
                            }
                            .settingsActionButtonStyle()
                        }

                        Text(viewModel.connectionLabel)
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(statusColor(viewModel.connectionStatus))
                    }
                    .glassCard()

                    VStack(alignment: .leading, spacing: 7) {
                        Text("Commandes Terminal")
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)

                        terminalLine("npm run wallet:server")
                        terminalLine("npm run wallet:set -- SOL 125")
                        terminalLine("npm run wallet:add -- ETH 0.42")
                        terminalLine("npm run wallet:status")

                        Text("Wallet update: \(fullDate(viewModel.walletUpdatedAt))")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.68))
                            .padding(.top, 4)
                    }
                    .glassCard()
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, 24)
            }
            .refreshable {
                await viewModel.refreshAll()
            }
            .navigationTitle("Settings")
        }
        .navigationViewStyle(.stack)
    }

    private func terminalLine(_ command: String) -> some View {
        Text(command)
            .font(.system(size: 12, weight: .medium, design: .monospaced))
            .foregroundStyle(.white.opacity(0.87))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 7)
            .padding(.horizontal, 10)
            .background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func statusColor(_ status: ConnectionStatus) -> Color {
        switch status {
        case .local:
            return .white.opacity(0.72)
        case .online:
            return .green.opacity(0.95)
        case .offline:
            return .red.opacity(0.95)
        }
    }
}

private struct TokenRowView: View {
    let coin: PortfolioCoin
    let showSparkline: Bool

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 9) {
                AsyncLogo(urlString: coin.imageURL)

                VStack(alignment: .leading, spacing: 2) {
                    Text(coin.name)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)

                    Text(coin.symbol)
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.68))
                }
            }

            Spacer(minLength: 0)

            VStack(alignment: .trailing, spacing: 2) {
                Text(currency(coin.usdValue))
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)

                Text("\(amount(coin.amount)) \(coin.symbol)")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.68))
            }

            if showSparkline {
                SparklineView(points: coin.sparkline, positive: (coin.change24h ?? 0) >= 0)
                    .frame(width: 75, height: 30)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
}

private struct MarketRowView: View {
    let rank: Int
    let coin: PortfolioCoin

    var body: some View {
        HStack(spacing: 8) {
            Text("#\(rank)")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .foregroundStyle(.white.opacity(0.56))
                .frame(width: 28)

            HStack(spacing: 8) {
                AsyncLogo(urlString: coin.imageURL)

                VStack(alignment: .leading, spacing: 2) {
                    Text(coin.name)
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)

                    Text(coin.symbol)
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.62))
                }
            }

            Spacer(minLength: 0)

            VStack(alignment: .trailing, spacing: 2) {
                Text(currency(coin.currentPrice))
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)

                Text(percent(coin.change24h))
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle((coin.change24h ?? 0) >= 0 ? Color.green.opacity(0.95) : Color.red.opacity(0.95))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
}

private struct AsyncLogo: View {
    let urlString: String

    var body: some View {
        AsyncImage(url: URL(string: urlString)) { phase in
            switch phase {
            case let .success(image):
                image
                    .resizable()
                    .scaledToFill()
            default:
                Circle().fill(.white.opacity(0.2))
            }
        }
        .frame(width: 26, height: 26)
        .clipShape(Circle())
    }
}

private struct SparklineView: View {
    let points: [Double]
    let positive: Bool

    var body: some View {
        GeometryReader { geometry in
            if points.count < 2 {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(.white.opacity(0.06))
            } else {
                Path { path in
                    let minPoint = points.min() ?? 0
                    let maxPoint = points.max() ?? 1
                    let verticalRange = max(maxPoint - minPoint, 0.00001)
                    let stepX = geometry.size.width / CGFloat(points.count - 1)

                    for (index, point) in points.enumerated() {
                        let normalizedY = (point - minPoint) / verticalRange
                        let x = CGFloat(index) * stepX
                        let y = geometry.size.height * (1 - CGFloat(normalizedY))

                        if index == 0 {
                            path.move(to: CGPoint(x: x, y: y))
                        } else {
                            path.addLine(to: CGPoint(x: x, y: y))
                        }
                    }
                }
                .stroke(
                    positive ? Color.green.opacity(0.92) : Color.red.opacity(0.92),
                    style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round)
                )
            }
        }
    }
}

private extension View {
    func glassCard(primary: Bool = false) -> some View {
        let base = RoundedRectangle(cornerRadius: 24, style: .continuous)

        return self
            .padding(14)
            .background(
                base
                    .fill(
                        LinearGradient(
                            colors: primary
                                ? [Color.white.opacity(0.2), Color.white.opacity(0.06)]
                                : [Color.white.opacity(0.12), Color.white.opacity(0.05)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            )
            .overlay(
                base
                    .stroke(Color.white.opacity(0.17), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.32), radius: 20, x: 0, y: 12)
    }

    func settingsActionButtonStyle() -> some View {
        self
            .font(.system(size: 12, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

private func currency(_ value: Double) -> String {
    CurrencyFormatter.string(from: value)
}

private func amount(_ value: Double) -> String {
    AmountFormatter.string(from: value)
}

private func percent(_ value: Double?) -> String {
    guard let value else {
        return "0.00%"
    }

    let sign = value > 0 ? "+" : ""
    return "\(sign)\(String(format: "%.2f", value))%"
}

private func time(_ value: Date?) -> String {
    guard let value else {
        return "--:--"
    }

    return ClockFormatter.shared.string(from: value)
}

private func fullDate(_ value: Date) -> String {
    FullDateFormatter.shared.string(from: value)
}

private enum CurrencyFormatter {
    static let shared: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 2
        formatter.locale = Locale(identifier: "en_US")
        return formatter
    }()

    static func string(from value: Double) -> String {
        shared.string(from: NSNumber(value: value)) ?? "$0.00"
    }
}

private enum AmountFormatter {
    static let shared: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 6
        formatter.locale = Locale(identifier: "en_US")
        return formatter
    }()

    static func string(from value: Double) -> String {
        if abs(value) >= 1000 {
            let compact = NumberFormatter()
            compact.numberStyle = .decimal
            compact.maximumFractionDigits = 2
            compact.usesSignificantDigits = true
            compact.maximumSignificantDigits = 4
            compact.locale = Locale(identifier: "en_US")
            return compact.string(from: NSNumber(value: value)) ?? "0"
        }

        return shared.string(from: NSNumber(value: value)) ?? "0"
    }
}

private enum ClockFormatter {
    static let shared: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()
}

private enum FullDateFormatter {
    static let shared: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}
